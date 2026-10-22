import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, sign} from 'node:crypto';
import {assembleCouncil, reviewCourt, fingerprint} from '../src/council.mjs';
import {prepareCouncilBusHandoff} from '../src/busHandoff.mjs';
import {verifyCouncilDeliveryEvidence} from '../src/deliveryProof.mjs';

const NOW = Date.parse('2026-10-22T12:05:00.000Z');
const origin = ()=>({agent:'chatgpt',route:'founder-relay',threadId:'thread-one',correlationId:'case-one'});
function signRecord(payload,privateKey) {
  const digest=Buffer.from(fingerprint(payload),'hex');
  return {...payload,signature:sign(null,digest,privateKey).toString('base64')};
}
function fixtures() {
  const council=assembleCouncil({
    roundId:'receipt-one',goal:'Verify independent reply path',sourceRef:'repo:sha',
    independent:false,seats:[
      {id:'codex',finding:'Unverified mock response',evidenceRefs:[],dissent:[],providerState:'SIMULATED'},
    ],
  });
  const court=reviewCourt(council,{
    claims:[{id:'live-provider',status:'UNKNOWN',witnesses:[]}],
    strongestChallenge:'Did a real provider answer?',dissent:[],
  });
  const handoff=prepareCouncilBusHandoff({council,court,origin:origin()});
  const bus=generateKeyPairSync('ed25519');
  const agent=generateKeyPairSync('ed25519');
  const delivery=signRecord({
    contract:'juss/council-bus-delivery@v1',handoffFingerprint:handoff.fingerprint,
    idempotencyKey:handoff.idempotencyKey,origin:origin(),state:'DELIVERED',
    deliveredAt:'2026-10-22T12:00:00.000Z',
  },bus.privateKey);
  const ack=signRecord({
    contract:'juss/council-origin-ack@v1',handoffFingerprint:handoff.fingerprint,
    deliveryFingerprint:fingerprint(delivery),origin:origin(),state:'ACKNOWLEDGED',
    acknowledgedAt:'2026-10-22T12:01:00.000Z',
  },agent.privateKey);
  return {council,court,handoff,delivery,ack,bus,agent};
}
const validInput=f=>({council:f.council,court:f.court,handoff:f.handoff,
  delivery:f.delivery,ack:f.ack,busPublicKey:f.bus.publicKey,
  originPublicKey:f.agent.publicKey,now:NOW});

test('separate signed Bus and origin receipts verify without implying a provider reply',()=>{
  const f=fixtures();
  const x=verifyCouncilDeliveryEvidence(validInput(f));
  assert.equal(x.state,'SIGNED_DELIVERY_AND_ORIGIN_ACK_VERIFIED');
  assert.equal(x.courtVerdict,'HOLD');
  assert.equal(x.providerInvocationVerified,false);
  assert.equal(x.grantsExecutionAuthority,false);
});
test('a Bus-only signature cannot forge originating AI acknowledgment',()=>{
  const f=fixtures();
  const {signature:_,...payload}=f.ack;
  const forged=signRecord(payload,f.bus.privateKey);
  assert.throws(()=>verifyCouncilDeliveryEvidence({...validInput(f),ack:forged}),/Unverified origin acknowledgment signature/);
});
test('the same trusted key cannot double as Bus and origin authority',()=>{
  const f=fixtures();
  assert.throws(()=>verifyCouncilDeliveryEvidence({...validInput(f),originPublicKey:f.bus.publicKey}),/distinct trusted keys/);
});
test('handoff signature must bind exact correlation ID and no callback URL',()=>{
  const f=fixtures();
  const tampered=structuredClone(f.delivery);
  tampered.origin.correlationId='other-case';
  assert.throws(()=>verifyCouncilDeliveryEvidence({...validInput(f),delivery:tampered}),/Origin identity mismatch/);
  const callback=structuredClone(f.delivery);
  callback.origin.callbackUrl='https://example.test';
  assert.throws(()=>verifyCouncilDeliveryEvidence({...validInput(f),delivery:callback}),/Invalid origin fields/);
});
test('a recomputed fingerprint cannot rescue a forged delivery signature',()=>{
  const f=fixtures();
  const altered={...f.delivery,state:'DELIVERED',deliveredAt:'2026-10-22T12:02:00.000Z'};
  assert.throws(()=>verifyCouncilDeliveryEvidence({...validInput(f),delivery:altered}),/Unverified Bus delivery signature/);
});
test('acknowledgment cannot reference different delivery or earlier delivery time',()=>{
  const f=fixtures();
  const alteredAck=signRecord({...f.ack,deliveryFingerprint:'0'.repeat(64),
    signature:undefined},f.agent.privateKey);
  assert.throws(()=>verifyCouncilDeliveryEvidence({...validInput(f),ack:alteredAck}),/not bound to verified delivery/);
  const {signature:_,...payload}=f.ack;
  const before=signRecord({...payload,acknowledgedAt:'2026-10-22T11:59:59.000Z'},f.agent.privateKey);
  assert.throws(()=>verifyCouncilDeliveryEvidence({...validInput(f),ack:before}),/predates delivery/);
});
test('stale or future receipt rejected despite valid signatures',()=>{
  const f=fixtures();
  assert.throws(()=>verifyCouncilDeliveryEvidence({...validInput(f),now:NOW+3600000}),/Stale or future delivery/);
  assert.throws(()=>verifyCouncilDeliveryEvidence({...validInput(f),now:NOW-900000}),/Stale or future delivery/);
});
test('no unsigned or missing acknowledgment counts as verified delivery',()=>{
  const f=fixtures();
  assert.throws(()=>verifyCouncilDeliveryEvidence({...validInput(f),ack:undefined}),/Invalid origin acknowledgment fields/);
  const unsigned={...f.ack};delete unsigned.signature;
  assert.throws(()=>verifyCouncilDeliveryEvidence({...validInput(f),ack:unsigned}),/Invalid origin acknowledgment fields/);
});
test('cannot substitute a handoff from another originating thread',()=>{
  const f=fixtures();
  const handoff=prepareCouncilBusHandoff({...f,origin:{...origin(),threadId:'other-thread'}});
  assert.throws(()=>verifyCouncilDeliveryEvidence({...validInput(f),handoff}),/Bus delivery not bound to this handoff/);
});
test('signature must use supported Ed25519 public key and canonical encoding',()=>{
  const f=fixtures();
  assert.throws(()=>verifyCouncilDeliveryEvidence({...validInput(f),busPublicKey:'not-a-key'}),/Invalid Bus public key/);
  const broken={...f.delivery,signature:'bad'};
  assert.throws(()=>verifyCouncilDeliveryEvidence({...validInput(f),delivery:broken}),/Invalid Bus delivery signature encoding/);
});
test('receipt verifier rejects unsupported claims and state elevation',()=>{
  const f=fixtures();
  const fake={...f.ack,approved:true};
  assert.throws(()=>verifyCouncilDeliveryEvidence({...validInput(f),ack:fake}),/Invalid origin acknowledgment fields/);
  const state={...f.delivery,state:'PROVIDER_VERIFIED'};
  assert.throws(()=>verifyCouncilDeliveryEvidence({...validInput(f),delivery:state}),/Bus delivery not bound/);
});
