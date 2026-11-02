import test from 'node:test';
import assert from 'node:assert/strict';
import {assembleCouncil, reviewCourt} from '../src/council.mjs';
import {prepareCouncilBusHandoff} from '../src/busHandoff.mjs';
import {runEmbeddedCouncilBus, EMBEDDED_BUS_CONTRACT} from '../src/councilBusRuntime.mjs';

function fixture(hold=false) {
  const council=assembleCouncil({roundId:'round-one',goal:'Evidence-bound finding',
    sourceRef:'repo-sha',independent:!hold,seats:[
      {id:'codex',finding:'Measured source',evidenceRefs:['sha'],dissent:[],providerState:'UNVERIFIED'},
    ]});
  const court=reviewCourt(council,{claims:[{id:'claim-one',status:'VERIFIED',
    witnesses:[{class:'repository_source',ref:'sha',root:'repo'}]}],
    strongestChallenge:'Is this externally verified?',dissent:[]});
  const origin={agent:'chatgpt',route:'founder-relay',threadId:'thread-one',correlationId:'case-one'};
  const handoff=prepareCouncilBusHandoff({council,court,origin});
  return {council,court,handoff,caller:{opaque:'not-persisted'}};
}
function harness() {
  const flags={ingress:true,dispatch:true,egress:true};
  const records=new Map();
  const calls=[];
  const ports={
    enabled: async stage => flags[stage],
    authenticate: async () => ({authenticated:true,subject:'founder',tenant:'juss'}),
    authorize: async () => true,
    journal:{
      claimOnce: async ({key}) => {
        if (records.has(key)) return false;
        records.set(key,{key,status:'PENDING'});
        return true;
      },
      finish:async record => {records.set(record.key, structuredClone(record));},
      read:async key => structuredClone(records.get(key)),
    },
    deliver:async input => {
      calls.push(input);
      return {status:'ACK',idempotencyKey:input.packet.idempotencyKey,
        correlationId:input.packet.correlationId,receiptId:'ack-one'};
    },
    verifyAck:async () => true,
  };
  return {flags,records,calls,ports};
}
test('embedded Bus routes only Court-ready metadata through trusted ports and persists ACK',async()=>{
  const f=fixture(), h=harness();
  const result=await runEmbeddedCouncilBus({...f,ports:h.ports});
  assert.equal(result.status,'ACK_REPORTED_BY_TRUSTED_PORT');
  assert.equal(result.authorityGranted,false);
  assert.equal(h.calls.length,1);
  assert.equal(h.calls[0].packet.contract,EMBEDDED_BUS_CONTRACT);
  assert.equal(h.calls[0].route,'founder-relay');
  assert.equal(h.calls[0].packet.grantsExecutionAuthority,false);
  assert.equal(JSON.stringify(h.calls[0]).includes('Measured source'),false);
  assert.equal(JSON.stringify(h.records.get(result.idempotencyKey)).includes('opaque'),false);
});
test('Court HOLD never calls a Bus port or delivers',async()=>{
  const f=fixture(true), h=harness();
  h.ports.authenticate=async()=>{throw new Error('should never authenticate');};
  const r=await runEmbeddedCouncilBus({...f,ports:h.ports});
  assert.equal(r.status,'COURT_HOLD');
  assert.equal(h.calls.length,0);
});
test('all three disabled stages fail closed without outbound delivery',async()=>{
  for (const stage of ['ingress','dispatch','egress']) {
    const f=fixture(),h=harness();h.flags[stage]=false;
    await assert.rejects(()=>runEmbeddedCouncilBus({...f,ports:h.ports}),/disabled/);
    assert.equal(h.calls.length,0);
  }
});
test('unproven caller identity and denied tenant permission cannot send',async()=>{
  const f=fixture(), h=harness();
  h.ports.authenticate=async()=>({authenticated:false,subject:'founder',tenant:'juss'});
  await assert.rejects(()=>runEmbeddedCouncilBus({...f,ports:h.ports}),/authenticated/);
  assert.equal(h.calls.length,0);
  h.ports.authenticate=async()=>({authenticated:true,subject:'founder',tenant:'juss'});
  h.ports.authorize=async()=>false;
  await assert.rejects(()=>runEmbeddedCouncilBus({...f,ports:h.ports}),/authorization/);
  assert.equal(h.calls.length,0);
});
test('durable idempotency prevents a second outbound callback',async()=>{
  const f=fixture(),h=harness();
  const first=await runEmbeddedCouncilBus({...f,ports:h.ports});
  const second=await runEmbeddedCouncilBus({...f,ports:h.ports});
  assert.equal(first.delivered,true);
  assert.equal(second.status,'DUPLICATE_NOT_SENT');
  assert.equal(h.calls.length,1);
});
test('concurrent same-key deliveries are blocked by atomic claim-once port',async()=>{
  const f=fixture(), h=harness();
  const result=await Promise.all([
    runEmbeddedCouncilBus({...f,ports:h.ports}),
    runEmbeddedCouncilBus({...f,ports:h.ports}),
  ]);
  assert.equal(result.filter(v=>v.delivered).length,1);
  assert.equal(h.calls.length,1);
});
test('forged ACK, missing signature verification and mismatched readback never return success',async()=>{
  const f=fixture(),h=harness();
  h.ports.deliver=async()=>({status:'ACK',idempotencyKey:'bad',
    correlationId:'case-one',receiptId:'ack-one'});
  await assert.rejects(()=>runEmbeddedCouncilBus({...f,ports:h.ports}),/Invalid Bus delivery ACK/);
  assert.equal(h.records.get(f.handoff.idempotencyKey).status,'PENDING');

  const f2=fixture(), h2=harness();
  h2.ports.verifyAck=async()=>false;
  await assert.rejects(()=>runEmbeddedCouncilBus({...f2,ports:h2.ports}),/verification rejected/);
  assert.equal(h2.records.get(f2.handoff.idempotencyKey).status,'PENDING');

  const f3=fixture(),h3=harness();
  h3.ports.journal.read=async()=>({key:'wrong'});
  await assert.rejects(()=>runEmbeddedCouncilBus({...f3,ports:h3.ports}),/readback mismatch/);
});
test('no silent fallbacks for missing ports or aborted operations',async()=>{
  const f=fixture(),h=harness();
  delete h.ports.authorize;
  await assert.rejects(()=>runEmbeddedCouncilBus({...f,ports:h.ports}),/Missing required Bus port/);
  const h2=harness(),controller=new AbortController();controller.abort();
  await assert.rejects(()=>runEmbeddedCouncilBus({...f,ports:h2.ports,signal:controller.signal}),/aborted/);
  assert.equal(h2.calls.length,0);
});
test('malformed, re-fingerprinted handoff cannot bypass Council/Court validation',async()=>{
  const f=fixture(),h=harness();
  f.handoff.deliveryStatus='DELIVERED';
  await assert.rejects(()=>runEmbeddedCouncilBus({...f,ports:h.ports}),/fingerprint|canonical/);
  assert.equal(h.calls.length,0);
});
