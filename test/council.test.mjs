import test from 'node:test';
import assert from 'node:assert/strict';
import {assembleCouncil, verifyCouncil, reviewCourt, fingerprint} from '../src/council.mjs';
const sample = () => assembleCouncil({roundId:'case-1',goal:'Check exact runtime and receipts',sourceRef:'repo@sha',independent:true,seats:[
  {id:'codex',finding:'Check commit and CI',dissent:['Do not infer deployment'],evidenceRefs:['source:sha'],providerState:'UNVERIFIED'},
  {id:'claude',finding:'Challenge user path',dissent:['Need browser'],evidenceRefs:[],providerState:'SIMULATED'}
]});
test('Council packet and verification preserve independent dissent and non-authority',()=>{const p=sample();assert.equal(verifyCouncil(p),true);assert.equal(p.authority.grantsExecutionAuthority,false);assert.equal(p.findings.length,2);});
test('Canonical fingerprint order invariant',()=>assert.equal(fingerprint({a:1,b:2}),fingerprint({b:2,a:1})));
test('Tampered Council findings fail closed',()=>{const p=sample();p.findings[0].finding='fake';assert.throws(()=>verifyCouncil(p),/mismatch/);});
test('Duplicated seats rejected',()=>assert.throws(()=>assembleCouncil({roundId:'case-1',goal:'Goal',sourceRef:'source',seats:[{id:'a',finding:'a',evidenceRefs:[],dissent:[],providerState:'SIMULATED'},{id:'a',finding:'b',evidenceRefs:[],dissent:[],providerState:'SIMULATED'}]}),/Repeated seat/));
test('Provider cannot simply claim LIVE',()=>assert.throws(()=>assembleCouncil({roundId:'case-1',goal:'Goal',sourceRef:'source',seats:[{id:'a',finding:'a',evidenceRefs:['provider:claim'],dissent:[],providerState:'LIVE'}]}),/provider label/));
test('Court holds unknown and unwitnessed claims',()=>{const result=reviewCourt(sample(),{claims:[{id:'runtime',status:'UNKNOWN',witnesses:[]}],strongestChallenge:'Is there runtime proof?',dissent:[]});assert.equal(result.verdict,'HOLD');assert.equal(result.authority.grantsExecutionAuthority,false);});
test('Court does not fake independent corroboration',()=>{const result=reviewCourt(sample(),{claims:[{id:'code',status:'VERIFIED',independent:true,witnesses:[{class:'repository_source',ref:'a',root:'same'},{class:'ci_receipt',ref:'b',root:'same'}]}],strongestChallenge:'Two citations but one root?',dissent:[]});assert.equal(result.verdict,'HOLD');assert.match(result.gaps.join(' '),/not independent/);});
test('Source/runtime green with missing visual proof remains HOLD',()=>{const result=reviewCourt(sample(),{claims:[{id:'code',status:'VERIFIED',witnesses:[{class:'repository_source',ref:'a',root:'repo'}]}],launchGate:{destinationIdentity:'VERIFIED',functionalRuntime:'VERIFIED',visualCanon:'FAIL'},strongestChallenge:'Does render match canon?',dissent:[]});assert.equal(result.verdict,'HOLD');});
test('Court without evidence gaps still does not claim external verification',()=>{const result=reviewCourt(sample(),{claims:[{id:'code',status:'VERIFIED',witnesses:[{class:'repository_source',ref:'a',root:'repo'}]}],strongestChallenge:'Check externally',dissent:[]});assert.equal(result.verdict,'READY_FOR_EXTERNAL_VERIFICATION');assert.equal(result.authority.grantsExecutionAuthority,false);});
test('No first-class Council independence triggers HOLD',()=>{const packet=assembleCouncil({roundId:'test-2',goal:'Goal',sourceRef:'repo',independent:false,seats:[{id:'codex',finding:'Yes',evidenceRefs:[],dissent:[],providerState:'UNVERIFIED'}]});assert.equal(reviewCourt(packet,{claims:[{id:'code',status:'VERIFIED',witnesses:[{class:'repository_source',ref:'a',root:'repo'}]}],strongestChallenge:'Challenge',dissent:[]}).verdict,'HOLD');});
// The fingerprint is integrity-only, NOT authentication. Adversaries can recompute
// it after changing untrusted JSON, so every authority/transport/provider field
// must be validated independently at the deserialization boundary.
const resign = packet => {
  const {fingerprint: _previous, ...record} = packet;
  return {...record, fingerprint:fingerprint(record)};
};
test('reject recomputed packet that reassigns founder authority', () => {
  const p=sample();p.authority.decisionOwner='provider';
  assert.throws(()=>verifyCouncil(resign(p)),/authority|owner|shape|authorize/i);
});
test('reject recomputed packet with extra execution authority', () => {
  const p=sample();p.authority.canMerge=true;
  assert.throws(()=>verifyCouncil(resign(p)),/authority|unknown/i);
});
test('reject recomputed packet with forged live provider seat', () => {
  const p=sample();p.findings[0].providerState='LIVE';
  assert.throws(()=>verifyCouncil(resign(p)),/provider|seat/i);
});
test('reject recomputed packet with seat approval injection', () => {
  const p=sample();p.findings[0].approved=true;
  assert.throws(()=>verifyCouncil(resign(p)),/seat|unknown/i);
});
test('reject recomputed packet with transport delivery assertions', () => {
  const p=sample();p.transport.deliveryStatus='DELIVERED';
  assert.throws(()=>verifyCouncil(resign(p)),/transport|unknown/i);
});
test('reject recomputed packet with top-level execution claim', () => {
  const p=sample();p.execution={authorized:true};
  assert.throws(()=>verifyCouncil(resign(p)),/unknown|field|packet/i);
});
test('reject non-text Council seat dissent',()=>{
  assert.throws(()=>assembleCouncil({roundId:'case-a',goal:'goal',sourceRef:'repo',seats:[{
    id:'model',finding:'finding',evidenceRefs:[],dissent:[{execute:'deploy'}],providerState:'UNVERIFIED'
  }]}),/dissent/i);
});
test('reject duplicated Court claims',()=>{
  const witness={class:'repository_source',ref:'abc',root:'repo'};
  assert.throws(()=>reviewCourt(sample(),{claims:[
    {id:'same',status:'VERIFIED',witnesses:[witness]},
    {id:'same',status:'VERIFIED',witnesses:[witness]}
  ],strongestChallenge:'challenge',dissent:[]}),/duplicat|repeated|unique/i);
});
test('reject non-text Court dissent',()=>{
  assert.throws(()=>reviewCourt(sample(),{claims:[{id:'code',status:'UNKNOWN',witnesses:[]}],
    strongestChallenge:'challenge',dissent:[{mutate:'repo'}]}),/dissent/i);
});
test('do not confuse two witness roots referencing the same upstream evidence with independent proof',()=>{
  const result=reviewCourt(sample(),{claims:[{id:'code',status:'VERIFIED',independent:true,witnesses:[
    {class:'repository_source',ref:'same',root:'repo'},
    {class:'ci_receipt',ref:'same',root:'ci'}
  ]}],strongestChallenge:'Verify upstream reference',dissent:[]});
  assert.equal(result.verdict,'HOLD');
});

test('Court visibly labels authoritative but uncorroborated single-witness claims',()=>{
  const result=reviewCourt(sample(),{claims:[{id:'code',status:'VERIFIED',witnesses:[{class:'repository_source',ref:'sha',root:'repo'}]}],strongestChallenge:'Independently reproduce?',dissent:[]});
  assert.equal(result.verdict,'READY_FOR_EXTERNAL_VERIFICATION');
  assert.match(result.limits.join(' '),/single-witness/);
});
test('reject malformed claim identifiers and hidden witness authority',()=>{
  assert.throws(()=>reviewCourt(sample(),{claims:[{id:{toString:()=> 'code'},status:'VERIFIED',witnesses:[]}],strongestChallenge:'challenge',dissent:[]}),/Invalid claim/);
  assert.throws(()=>reviewCourt(sample(),{claims:[{id:'code',status:'VERIFIED',witnesses:[{class:'repository_source',ref:'sha',root:'repo',grantsExecutionAuthority:true}]}],strongestChallenge:'challenge',dissent:[]}),/witness field/);
});