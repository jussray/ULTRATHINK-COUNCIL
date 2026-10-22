import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync,sign} from 'node:crypto';
import {assembleCouncil,reviewCourt,fingerprint} from '../src/council.mjs';
import {prepareCouncilBusHandoff} from '../src/busHandoff.mjs';
import {verifyCouncilDeliveryEvidence} from '../src/deliveryProof.mjs';
import {createLocalCouncilBus} from '../bus/localBus.mjs';
import {createLocalCouncilBusServer} from '../bus/http.mjs';
const NOW=Date.parse('2026-10-22T12:05:00.000Z');
const signature=(v,privateKey)=>({...v,signature:sign(null,Buffer.from(fingerprint(v),'hex'),privateKey).toString('base64')});
const ORIGIN={agent:'chatgpt',route:'founder-relay',threadId:'thread-one',correlationId:'case-one'};
function fixture(){
  const ingress=generateKeyPairSync('ed25519'),origin=generateKeyPairSync('ed25519'),
    bus=generateKeyPairSync('ed25519');
  const dir=mkdtempSync(join(tmpdir(),'council-bus-'));
  const council=assembleCouncil({roundId:'round-one',goal:'Return a checked result',sourceRef:'repo@sha',
    independent:false,seats:[{id:'codex',finding:'Local mock only',providerState:'SIMULATED',evidenceRefs:[],dissent:[]}]});
  const court=reviewCourt(council,{claims:[{id:'provider',status:'UNKNOWN',witnesses:[]}],
    strongestChallenge:'Is there proof of a live provider?',dissent:[]});
  const handoff=prepareCouncilBusHandoff({council,court,origin:ORIGIN});
  let t=NOW;const config={dbPath:join(dir,'data.sqlite'),ingressPublicKey:ingress.publicKey,
    originPublicKey:origin.publicKey,busPrivateKey:bus.privateKey,
    allowedOriginAgent:'chatgpt',allowedOriginRoute:'founder-relay',now:()=>t};
  const submission=signature({contract:'juss/council-bus-submit@v1',council,court,handoff,
    reply:'A bounded response for the right originating thread.',
    issuedAt:new Date(NOW).toISOString()},ingress.privateKey);
  const claim=nonce=>signature({contract:'juss/council-bus-claim@v1',origin:ORIGIN,
    issuedAt:new Date(NOW).toISOString(),nonce},origin.privateKey);
  const ack=delivery=>signature({contract:'juss/council-origin-ack@v1',
    handoffFingerprint:handoff.fingerprint,deliveryFingerprint:fingerprint(delivery),
    origin:ORIGIN,state:'ACKNOWLEDGED',
    acknowledgedAt:new Date(NOW+1000).toISOString()},origin.privateKey);
  return {config,ingress,origin,bus,council,court,handoff,submission,claim,ack,
    setTime:x=>{t=x;},cleanup:()=>rmSync(dir,{recursive:true,force:true})};
}
test('genuine signed submit → claimed origin inbox → separate signed ACK survives restart',()=>{
  const f=fixture();
  try{
    let client=createLocalCouncilBus(f.config);
    assert.equal(client.publish(f.submission).state,'QUEUED');
    assert.equal(client.publish(f.submission).duplicate,true);
    const claimed=client.claim(f.claim('1'.repeat(32)));
    assert.equal(claimed.state,'DELIVERY_ATTEMPTED');
    assert.equal(claimed.message,'A bounded response for the right originating thread.');
    const validated=verifyCouncilDeliveryEvidence({
      council:f.council,court:f.court,handoff:f.handoff,
      delivery:claimed.delivery,ack:f.ack(claimed.delivery),
      busPublicKey:f.bus.publicKey,originPublicKey:f.origin.publicKey,now:NOW+1000,
    });
    assert.equal(validated.courtVerdict,'HOLD');
    client.close();
    client=createLocalCouncilBus(f.config);
    assert.equal(client.acknowledge(f.ack(claimed.delivery)).state,'ACKNOWLEDGED');
    assert.equal(client.acknowledge(f.ack(claimed.delivery)).idempotent,true);
    assert.equal(client.claim(f.claim('2'.repeat(32))).state,'EMPTY');
    client.close();
  }finally{f.cleanup();}
});
test('unsigned submission and forged origin claim are rejected',()=>{
  const f=fixture();const client=createLocalCouncilBus(f.config);
  try {
    assert.throws(()=>client.publish({...f.submission,signature:'bad'}),/UNAUTHENTICATED/);
    client.publish(f.submission);
    const wrong=signature({contract:'juss/council-bus-claim@v1',origin:ORIGIN,
      issuedAt:new Date(NOW).toISOString(),nonce:'3'.repeat(32)},f.ingress.privateKey);
    assert.throws(()=>client.claim(wrong),/UNAUTHENTICATED/);
    assert.equal(client.claim(f.claim('4'.repeat(32))).state,'DELIVERY_ATTEMPTED');
    assert.throws(()=>client.claim(f.claim('4'.repeat(32))),/REPLAYED_CLAIM/);
  }finally{client.close();f.cleanup();}
});
test('origin isolation and arbitrary callback fields cannot pass signed ingress',()=>{
  const f=fixture();const client=createLocalCouncilBus(f.config);
  try {
    const wrong={...f.handoff,origin:{...ORIGIN,route:'unauthorized'}};
    const {signature:oldSignature,...payload}=f.submission;
    const signed=signature({...payload,handoff:wrong},f.ingress.privateKey);
    assert.throws(()=>client.publish(signed),/INVALID_SUBMISSION|UNAUTHENTICATED|fingerprint/);
    client.publish(f.submission);
    const foreign=signature({contract:'juss/council-bus-claim@v1',
      origin:{...ORIGIN,route:'not-allowed'},issuedAt:new Date(NOW).toISOString(),
      nonce:'5'.repeat(32)},f.origin.privateKey);
    assert.throws(()=>client.claim(foreign),/ORIGIN_NOT_AUTHORIZED/);
  }finally{client.close();f.cleanup();}
});
test('reply conflict cannot overwrite an existing handoff',()=>{
  const f=fixture();const client=createLocalCouncilBus(f.config);
  try{
    client.publish(f.submission);
    const {signature:old,...payload}=f.submission;
    const altered=signature({...payload,reply:'A different answer'},f.ingress.privateKey);
    assert.throws(()=>client.publish(altered),/CONFLICTING_HANDOFF/);
  }finally{client.close();f.cleanup();}
});
test('bad ACK correlation and re-signed wrong delivery are rejected',()=>{
  const f=fixture();const client=createLocalCouncilBus(f.config);
  try{
    client.publish(f.submission);
    const {delivery}=client.claim(f.claim('6'.repeat(32)));
    const {signature:oldSignature,...payload}=f.ack(delivery);
    const fake=signature({...payload,deliveryFingerprint:'f'.repeat(64)},f.origin.privateKey);
    assert.throws(()=>client.acknowledge(fake),/INVALID_ACK|ACK_DELIVERY_MISMATCH/);
    const forged=signature({contract:'juss/council-origin-ack@v1',handoffFingerprint:f.handoff.fingerprint,
      deliveryFingerprint:fingerprint(delivery),origin:ORIGIN,state:'ACKNOWLEDGED',
      acknowledgedAt:new Date(NOW+1000).toISOString()},f.ingress.privateKey);
    assert.throws(()=>client.acknowledge(forged),/UNAUTHENTICATED/);
  }finally{client.close();f.cleanup();}
});
test('stale signed claims fail and do not consume delivery',()=>{
  const f=fixture();const client=createLocalCouncilBus(f.config);
  try {
    client.publish(f.submission);
    f.setTime(NOW+600000);
    assert.throws(()=>client.claim(f.claim('7'.repeat(32))),/STALE_OR_INVALID_TIME/);
    f.setTime(NOW);
    assert.equal(client.claim(f.claim('8'.repeat(32))).state,'DELIVERY_ATTEMPTED');
  }finally{client.close();f.cleanup();}
});
test('HTTP interface remains local, bounded and enforces signed inputs',async()=>{
  const f=fixture();const bus=createLocalCouncilBus(f.config);
  const server=createLocalCouncilBusServer(bus);
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const {port}=server.address();
  const post=(path,payload)=>fetch('http://127.0.0.1:'+port+path,
    {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  try{
    const unauth=await post('/v1/publish',{contract:'fake'});
    assert.equal(unauth.status,400);
    const result=await post('/v1/publish',f.submission);
    assert.equal(result.status,200);
    const body=await result.json();
    assert.equal(body.state,'QUEUED');
    const claim=await post('/v1/claim',f.claim('9'.repeat(32)));
    assert.equal(claim.status,200);
    assert.equal((await claim.json()).state,'DELIVERY_ATTEMPTED');
    const health=await fetch('http://127.0.0.1:'+port+'/health');
    assert.equal((await health.json()).mode,'local-reference');
  }finally{await new Promise(done=>server.close(done));bus.close();f.cleanup();}
});
