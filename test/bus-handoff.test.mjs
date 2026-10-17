import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleCouncil, reviewCourt, verifyCourt, fingerprint,
} from '../src/council.mjs';
import {prepareCouncilBusHandoff, verifyCouncilBusHandoff} from '../src/busHandoff.mjs';

const origin = () => ({agent:'chatgpt',route:'founder-relay',threadId:'thread-one',correlationId:'case-one'});
const fixture = (launchGate) => {
  const council = assembleCouncil({roundId:'round-one',goal:'Check code evidence',sourceRef:'repo-sha',independent:true,seats:[
    {id:'codex',finding:'Source check',dissent:[],evidenceRefs:['sha'],providerState:'UNVERIFIED'},
    {id:'claude',finding:'Challenge result',dissent:['Check runtime'],evidenceRefs:[],providerState:'SIMULATED'},
  ]});
  const court = reviewCourt(council,{claims:[{id:'code',status:'VERIFIED',witnesses:[
    {class:'repository_source',ref:'sha',root:'repo'}
  ]}],strongestChallenge:'What independent verification exists?',dissent:[],
  ...(launchGate ? {launchGate} : {})});
  return {council, court};
};
const resign = value => { const {fingerprint:_old,...record}=value; return {...record,fingerprint:fingerprint(record)}; };

test('Court record now preserves failing launch gate across transport', () => {
  const {council,court}=fixture({destinationIdentity:'VERIFIED',functionalRuntime:'VERIFIED',visualCanon:'FAIL'});
  assert.equal(court.verdict,'HOLD');
  assert.equal(court.launchGate.visualCanon,'FAIL');
  assert.equal(verifyCourt(council,court),true);
});
test('Court record without launch context is re-verifiable when explicitly null', () => {
  const {council,court}=fixture();
  assert.equal(court.launchGate,null);
  assert.equal(verifyCourt(council,court),true);
});
test('Court verifier rejects old ambiguous record without launch context', () => {
  const {council,court}=fixture();
  delete court.launchGate;
  assert.throws(()=>verifyCourt(council,resign(court)),/Court record/);
});
test('Court verifier rejects re-fingerprinted fake green verdict', () => {
  const {council,court}=fixture({destinationIdentity:'VERIFIED',functionalRuntime:'VERIFIED',visualCanon:'FAIL'});
  court.verdict='READY_FOR_EXTERNAL_VERIFICATION';
  assert.throws(()=>verifyCourt(council,resign(court)),/recheck/);
});
test('Court verifier rejects re-fingerprinted omission of visual failure', () => {
  const {council,court}=fixture({destinationIdentity:'VERIFIED',functionalRuntime:'VERIFIED',visualCanon:'FAIL'});
  court.launchGate=null;
  assert.throws(()=>verifyCourt(council,resign(court)),/recheck/);
});
test('Court verifier rejects changed Council lineage', () => {
  const {council,court}=fixture();
  court.councilFingerprint='0'.repeat(64);
  assert.throws(()=>verifyCourt(council,resign(court)),/lineage/);
});
test('Council Bus handoff preserves origin binding and HOLD without sending', () => {
  const {council,court}=fixture({destinationIdentity:'VERIFIED',functionalRuntime:'VERIFIED',visualCanon:'UNKNOWN'});
  const handoff=prepareCouncilBusHandoff({council,court,origin:origin()});
  assert.equal(verifyCouncilBusHandoff({council,court,handoff}),true);
  assert.equal(handoff.deliveryStatus,'PREPARED_NOT_SENT');
  assert.equal(handoff.decisionStatus,'HOLD');
  assert.equal(handoff.authority.grantsExecutionAuthority,false);
  assert.equal(JSON.stringify(handoff).includes('Challenge result'),false);
});
test('Identical handoff has deterministic idempotency key', () => {
  const {council,court}=fixture();
  const a=prepareCouncilBusHandoff({council,court,origin:origin()});
  const b=prepareCouncilBusHandoff({council,court,origin:origin()});
  assert.deepEqual(a,b);
});
test('Correlated replies remain distinct even for identical court record', () => {
  const {council,court}=fixture();
  const a=prepareCouncilBusHandoff({council,court,origin:origin()});
  const b=prepareCouncilBusHandoff({council,court,origin:{...origin(),correlationId:'case-two'}});
  assert.notEqual(a.idempotencyKey,b.idempotencyKey);
});
test('Do not allow callback URLs or origin credential injection', () => {
  const {council,court}=fixture();
  assert.throws(()=>prepareCouncilBusHandoff({council,court,origin:{...origin(),route:'https://attacker.test'}}),/route/);
  assert.throws(()=>prepareCouncilBusHandoff({council,court,origin:{...origin(),credential:'secret'}}),/origin/);
});
test('A delivery-status edit without re-fingerprinting must fail closed', () => {
  const {council,court}=fixture();
  const handoff=prepareCouncilBusHandoff({council,court,origin:origin()});
  handoff.deliveryStatus='DELIVERED';
  assert.throws(()=>verifyCouncilBusHandoff({council,court,handoff}),/payload fingerprint/);
});

test('A re-fingerprinted delivery claim is rejected', () => {
  const {council,court}=fixture();
  const handoff=prepareCouncilBusHandoff({council,court,origin:origin()});
  handoff.deliveryStatus='DELIVERED';
  assert.throws(()=>verifyCouncilBusHandoff({council,court,handoff:resign(handoff)}),/fingerprint|canonical/);
});
test('Bus handoff cannot self-grant a provider or merge authority', () => {
  const {council,court}=fixture();
  const handoff=prepareCouncilBusHandoff({council,court,origin:origin()});
  handoff.authority={decisionOwner:'provider',grantsExecutionAuthority:true};
  assert.throws(()=>verifyCouncilBusHandoff({council,court,handoff:resign(handoff)}),/fingerprint|canonical/);
});
test('Bus handoff rejects substituted Court or Council fingerprints', () => {
  const {council,court}=fixture();
  const handoff=prepareCouncilBusHandoff({council,court,origin:origin()});
  handoff.courtFingerprint='a'.repeat(64);
  assert.throws(()=>verifyCouncilBusHandoff({council,court,handoff:resign(handoff)}),/fingerprint|canonical/);
});

test('Canonical handoff verification accepts equivalent JSON key order', () => {
  const {council,court}=fixture();
  const handoff=prepareCouncilBusHandoff({council,court,origin:origin()});
  const reordered=Object.fromEntries(Object.entries(handoff).reverse());
  assert.equal(verifyCouncilBusHandoff({council,court,handoff:reordered}),true);
});