import test from 'node:test';
import assert from 'node:assert/strict';
import {runLocalCouncilRound,verifyLocalCouncilRound,prepareLocalCourtHandoff} from '../src/round.mjs';
import {verifyCouncil,verifyCourt} from '../src/council.mjs';
import {verifyCouncilBusHandoff} from '../src/busHandoff.mjs';

const basis=()=>({
  roundId:'case-round-one',goal:'Compare Council findings',sourceRef:'repo:sha',
  seed:'first context',seats:['codex','claude'],
  clock:()=> '2026-10-22T00:00:00Z',
});
const mock=async request=>({status:'completed',requestHash:request.requestHash,
  answer:`${request.seat} on ${request.context}`,providerState:'SIMULATED',
  evidenceRefs:['simulated:local-test'],dissent:[]});
const origin={agent:'chatgpt',route:'founder-relay',threadId:'thread-one',correlationId:'case-one'};

test('portable export imports the existing Council and Court with no third-party dependencies',async()=>{
  const api=await import('../src/index.mjs');
  for(const name of ['assembleCouncil','verifyCouncil','reviewCourt','verifyCourt',
    'prepareCouncilBusHandoff','verifyCouncilBusHandoff','runLocalCouncilRound',
    'verifyLocalCouncilRound','prepareLocalCourtHandoff']) assert.equal(typeof api[name],'function');
});
test('local chained answers retain order and content hashes',async()=>{
  const calls=[];
  const t=await runLocalCouncilRound({...basis(),dispatch:async q=>{calls.push(q);return mock(q);}});
  assert.equal(t.state,'complete');
  assert.deepEqual(t.hops.map(h=>h.seat),['codex','claude']);
  assert.equal(calls[0].context,'first context');
  assert.equal(calls[1].context,'codex on first context');
  assert.equal(t.hops[1].contextHash,t.hops[0].answerHash);
  assert.equal(t.nextSeatIndex,2);
  assert.equal(verifyLocalCouncilRound(t),true);
  assert.equal(t.hops[0].liveProviderEvidence,false);
});
test('blocked seat stops chain; resume does not recall completed seats',async()=>{
  const called=[];
  const dispatch=async q=>{
    called.push(q.seat);
    return q.seat==='claude' ? {status:'blocked',requestHash:q.requestHash} : mock(q);
  };
  const first=await runLocalCouncilRound({...basis(),dispatch});
  assert.equal(first.state,'interrupted');
  assert.equal(first.nextSeatIndex,1);
  assert.deepEqual(called,['codex','claude']);
  const resumed=await runLocalCouncilRound({...basis(),resumeFrom:first,
    dispatch:async q=>{called.push(q.seat);return mock(q);}});
  assert.equal(resumed.state,'complete');
  assert.deepEqual(called,['codex','claude','claude']);
});
test('provider exception is interrupted without exposing secret-bearing error text',async()=>{
  const r=await runLocalCouncilRound({...basis(),dispatch:async()=>{throw Error('secret=123');}});
  assert.equal(r.interruption.reason,'DISPATCH_ERROR');
  assert.equal(JSON.stringify(r).includes('123'),false);
});
test('forged live provider assertion cannot become a completed hop',async()=>{
  const r=await runLocalCouncilRound({...basis(),dispatch:async q=>({...await mock(q),providerState:'EXTERNALLY_ATTESTED'})});
  assert.equal(r.state,'interrupted');
  assert.equal(r.interruption.reason,'INVALID_RESPONSE');
  assert.equal(r.hops.length,0);
});
test('unexpected response fields fail closed instead of granting hidden authority',async()=>{
  const r=await runLocalCouncilRound({...basis(),dispatch:async q=>({...await mock(q),approved:true})});
  assert.equal(r.state,'interrupted');
  assert.equal(r.interruption.reason,'INVALID_RESPONSE');
});
test('source identity and seat order must match on resume',async()=>{
  const first=await runLocalCouncilRound({...basis(),dispatch:async q=>q.seat==='claude'?{status:'blocked',requestHash:q.requestHash}:mock(q)});
  await assert.rejects(runLocalCouncilRound({...basis(),sourceRef:'forged',
    resumeFrom:first,dispatch:mock}),/identity/);
  await assert.rejects(runLocalCouncilRound({...basis(),seats:['claude','codex'],
    resumeFrom:first,dispatch:mock}),/identity/);
});
test('a tampered stored answer cannot be resumed',async()=>{
  const first=await runLocalCouncilRound({...basis(),dispatch:async q=>q.seat==='claude'?{status:'blocked',requestHash:q.requestHash}:mock(q)});
  first.hops[0].answer='forged';
  await assert.rejects(runLocalCouncilRound({...basis(),resumeFrom:first,dispatch:mock}),/fingerprint|answer hash/);
});
test('roster rejects duplicate seats or FCR masquerading as a model',async()=>{
  await assert.rejects(runLocalCouncilRound({...basis(),seats:['codex','codex'],dispatch:mock}),/seat/);
  await assert.rejects(runLocalCouncilRound({...basis(),seats:['fcr'],dispatch:mock}),/seat/);
});
test('only completed rounds may produce Court and Bus metadata',async()=>{
  const t=await runLocalCouncilRound({...basis(),dispatch:async q=>({status:'blocked',requestHash:q.requestHash})});
  assert.throws(()=>prepareLocalCourtHandoff({transcript:t,origin,claims:[],
    strongestChallenge:'What is really verified?'}),/incomplete/);
});
test('local Court preserves HOLD and Bus is prepared but NOT sent',async()=>{
  const t=await runLocalCouncilRound({...basis(),dispatch:mock});
  const out=prepareLocalCourtHandoff({
    transcript:t,origin,
    claims:[{id:'source',status:'VERIFIED',witnesses:[{
      class:'repository_source',ref:'repo:sha',root:'repo'}]}],
    strongestChallenge:'Are these independent actual provider replies?',
    dissent:['Only simulated providers were run'],
  });
  assert.equal(verifyCouncil(out.council),true);
  assert.equal(verifyCourt(out.council,out.court),true);
  assert.equal(verifyCouncilBusHandoff(out),true);
  assert.equal(out.council.independent,false);
  assert.equal(out.court.verdict,'HOLD');
  assert.equal(out.handoff.deliveryStatus,'PREPARED_NOT_SENT');
  assert.equal(out.handoff.authority.grantsExecutionAuthority,false);
  assert.equal(out.handoff.transport?.deliveryProof,undefined);
});
test('no arbitrary callback URL may be smuggled into origin',async()=>{
  const t=await runLocalCouncilRound({...basis(),dispatch:mock});
  assert.throws(()=>prepareLocalCourtHandoff({
    transcript:t,origin:{...origin,route:'https://wrong.example'},
    claims:[{id:'source',status:'UNKNOWN',witnesses:[]}],
    strongestChallenge:'Is this a safe route?'
  }),/route/);
});
test('launch visual FAIL remains Court HOLD with full source green',async()=>{
  const t=await runLocalCouncilRound({...basis(),dispatch:mock});
  const a=prepareLocalCourtHandoff({
    transcript:t,origin,claims:[{id:'source',status:'VERIFIED',witnesses:[{
      class:'repository_source',ref:'repo:sha',root:'repo'}]}],
    launchGate:{destinationIdentity:'VERIFIED',functionalRuntime:'VERIFIED',visualCanon:'FAIL'},
    strongestChallenge:'Does the destination actually render the intended design?'
  });
  assert.equal(a.court.verdict,'HOLD');
  assert.ok(a.court.gaps.some(g=>g.includes('visualCanon')));
});

test('an answer from another request is rejected even when its text looks valid',async()=>{
  const t=await runLocalCouncilRound({...basis(),dispatch:async q=>({...await mock(q),requestHash:'0'.repeat(64)})});
  assert.equal(t.state,'interrupted');
  assert.equal(t.interruption.reason,'INVALID_RESPONSE');
  assert.equal(t.hops.length,0);
});
test('unbound blocked replies cannot stop another correlated round',async()=>{
  const t=await runLocalCouncilRound({...basis(),dispatch:async()=>({status:'blocked',requestHash:'other'})});
  assert.equal(t.interruption.reason,'INVALID_RESPONSE');
});
test('unresponsive seat times out and signals best-effort cancellation',async()=>{
  let signal;
  const t=await runLocalCouncilRound({...basis(),timeoutMs:10,dispatch:async q=>{
    signal=q.signal;
    return new Promise(()=>{});
  }});
  assert.equal(t.state,'interrupted');
  assert.equal(t.interruption.reason,'TIMED_OUT');
  assert.equal(t.nextSeatIndex,0);
  assert.equal(signal.aborted,true);
});
test('timeouts are budgeted, never arbitrary or disabled',async()=>{
  await assert.rejects(runLocalCouncilRound({...basis(),timeoutMs:0,dispatch:mock}),/timeout/);
  await assert.rejects(runLocalCouncilRound({...basis(),timeoutMs:60001,dispatch:mock}),/timeout/);
});
test('oversized initial context and excessive seats fail before any dispatch',async()=>{
  let count=0;
  const dispatch=async q=>{count++;return mock(q);};
  await assert.rejects(runLocalCouncilRound({...basis(),seed:'a'.repeat(32769),dispatch}),/oversized/);
  await assert.rejects(runLocalCouncilRound({...basis(),seats:Array.from({length:9},(_,i)=>'seat-'+i),dispatch}),/seat/);
  assert.equal(count,0);
});
test('oversized response and evidence lists stop the hop, not persist them',async()=>{
  const huge=await runLocalCouncilRound({...basis(),dispatch:async q=>({...await mock(q),answer:'z'.repeat(32769)})});
  assert.equal(huge.interruption.reason,'INVALID_RESPONSE');
  const many=await runLocalCouncilRound({...basis(),dispatch:async q=>({...await mock(q),evidenceRefs:Array.from({length:33},(_,i)=>'ref-'+i)})});
  assert.equal(many.interruption.reason,'INVALID_RESPONSE');
});
test('malformed stored transcript is rejected even if attacker recomputes its hash',async()=>{
  const t=await runLocalCouncilRound({...basis(),dispatch:mock});
  t.hops[0].answer='a'.repeat(32769);
  const {fingerprint:old, ...rest}=t;
  const {fingerprint}=await import('../src/council.mjs');
  t.fingerprint=fingerprint(rest);
  assert.throws(()=>verifyLocalCouncilRound(t),/answer hash|mismatch/);
});

test('same round and same seat receive fresh request hashes for each attempt',async()=>{
  const cfg={...basis(),seats:['codex']};
  const a=await runLocalCouncilRound({...cfg,dispatch:mock});
  const b=await runLocalCouncilRound({...cfg,dispatch:mock});
  assert.notEqual(a.hops[0].attemptId,b.hops[0].attemptId);
  assert.notEqual(a.hops[0].requestHash,b.hops[0].requestHash);
  assert.equal(verifyLocalCouncilRound(a),true);
  assert.equal(verifyLocalCouncilRound(b),true);
});
test('replayed response from the same interrupted round cannot clear a retry',async()=>{
  let saved;
  const first=await runLocalCouncilRound({...basis(),dispatch:async q=>{
    if(q.seat==='codex')return mock(q);
    saved={...await mock(q)};
    return {status:'blocked',requestHash:q.requestHash};
  }});
  const resumed=await runLocalCouncilRound({...basis(),resumeFrom:first,dispatch:async q=>{
    assert.equal(q.seat,'claude');
    assert.notEqual(q.requestHash,saved.requestHash);
    return saved;
  }});
  assert.equal(resumed.state,'interrupted');
  assert.equal(resumed.interruption.reason,'INVALID_RESPONSE');
  assert.equal(resumed.hops.length,1);
});
test('legacy round v1 is explicitly rejected rather than silently migrated',async()=>{
  const old=await runLocalCouncilRound({...basis(),dispatch:mock});
  const {fingerprint}=await import('../src/council.mjs');
  old.contract='juss/portable-council-round@v1';
  const {fingerprint:_prior,...data}=old;
  old.fingerprint=fingerprint(data);
  assert.throws(()=>verifyLocalCouncilRound(old),/Unknown round contract/);
});
test('recomputed round digest does not conceal a duplicated attempt identifier',async()=>{
  const t=await runLocalCouncilRound({...basis(),dispatch:mock});
  t.hops[1].attemptId=t.hops[0].attemptId;
  const {fingerprint}=await import('../src/council.mjs');
  const {fingerprint:_prior,...data}=t;
  t.fingerprint=fingerprint(data);
  assert.throws(()=>verifyLocalCouncilRound(t),/repeated Council attempt identity/);
});
test('timeout resume requires owner retry-safety evidence, without recalling finished seats',async()=>{
  let timedOutSignal;
  const first=await runLocalCouncilRound({...basis(),timeoutMs:5,dispatch:async q=>{
    if(q.seat==='codex')return mock(q);
    timedOutSignal=q.signal;
    return new Promise(()=>{});
  }});
  assert.equal(first.interruption.reason,'TIMED_OUT');
  assert.equal(timedOutSignal.aborted,true);
  let called=0;
  const dispatch=async q=>{called++;return mock(q)};
  await assert.rejects(runLocalCouncilRound({...basis(),resumeFrom:first,dispatch}),/requires trusted owner/);
  await assert.rejects(runLocalCouncilRound({...basis(),resumeFrom:first,dispatch,
    verifyRetrySafety:async()=>false}),/not cleared/);
  assert.equal(called,0);
  let reason;
  const resumed=await runLocalCouncilRound({...basis(),resumeFrom:first,dispatch,
    verifyRetrySafety:async info=>{reason=info;return true;}});
  assert.equal(reason.seat,'claude');
  assert.equal(reason.priorFingerprint,first.fingerprint);
  assert.equal(resumed.state,'complete');
  assert.equal(called,1);
});
test('retry safety adapter exceptions are redacted and do not retry',async()=>{
  const first=await runLocalCouncilRound({...basis(),timeoutMs:5,dispatch:async()=>new Promise(()=>{})});
  await assert.rejects(runLocalCouncilRound({...basis(),resumeFrom:first,
    verifyRetrySafety:async()=>{throw new Error('password=private');},
    dispatch:mock}),/not cleared/);
});
