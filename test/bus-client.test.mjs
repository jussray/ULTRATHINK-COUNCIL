import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {assembleCouncil,reviewCourt} from '../src/council.mjs';
import {prepareCouncilBusHandoff} from '../src/busHandoff.mjs';
import {createLocalCouncilBus} from '../bus/localBus.mjs';
import {createLocalCouncilBusServer} from '../bus/http.mjs';
import {createLocalCouncilBusClient} from '../bus/client.mjs';

const NOW=Date.parse('2026-10-22T12:00:01.000Z');
const ORIGIN={agent:'chatgpt',route:'founder-relay',threadId:'round-one',correlationId:'case-one'};
const signedSetup=()=>{
  const dir=mkdtempSync(join(tmpdir(),'council-bus-clients-'));
  const ingress=generateKeyPairSync('ed25519'),origin=generateKeyPairSync('ed25519'),
    bus=generateKeyPairSync('ed25519');
  const config={dbPath:join(dir,'data.sqlite'),ingressPublicKey:ingress.publicKey,
    originPublicKey:origin.publicKey,busPrivateKey:bus.privateKey,
    allowedOriginAgent:ORIGIN.agent,allowedOriginRoute:ORIGIN.route,now:()=>NOW};
  const council=assembleCouncil({
    roundId:'round-one',goal:'Please answer',sourceRef:'repo:sha',independent:false,
    seats:[{id:'codex',finding:'A mock-only answer',providerState:'SIMULATED',evidenceRefs:[],dissent:[]}],
  });
  const court=reviewCourt(council,{claims:[{id:'actual-provider',status:'UNKNOWN',witnesses:[]}],
    strongestChallenge:'Any live provider proof?',dissent:[]});
  const handoff=prepareCouncilBusHandoff({council,court,origin:ORIGIN});
  return {dir,config,keys:{ingress,origin,bus},council,court,handoff,
    cleanup:()=>rmSync(dir,{recursive:true,force:true})};
};
async function setup(){
  const fx=signedSetup(),bus=createLocalCouncilBus(fx.config),
    server=createLocalCouncilBusServer(bus);
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const url='http://127.0.0.1:'+server.address().port+'/';
  const client=createLocalCouncilBusClient({url,origin:ORIGIN,
    ingressPrivateKey:fx.keys.ingress.privateKey,
    originPrivateKey:fx.keys.origin.privateKey,
    busPublicKey:fx.keys.bus.publicKey,
    now:()=>NOW});
  return {fx,bus,client,url,cleanup:async()=>{
    await new Promise(done=>server.close(done));
    bus.close();fx.cleanup();
  }};
}
test('producer signs a Council result and origin verifies, handles and ACKs it',async()=>{
  const x=await setup();
  try{
    assert.equal((await x.client.submit({council:x.fx.council,court:x.fx.court,
      handoff:x.fx.handoff,reply:'Reply from tested local Council reference.'})).state,'QUEUED');
    let received;
    const result=await x.client.receiveAndAcknowledge(async m=>{
      received=m;
      return true;
    });
    assert.equal(received.message,'Reply from tested local Council reference.');
    assert.equal(received.handoff.fingerprint,x.fx.handoff.fingerprint);
    assert.equal(result.state,'ACKNOWLEDGED');
    assert.equal((await x.client.receiveAndAcknowledge(async()=>true)).state,'EMPTY');
  }finally{await x.cleanup();}
});
test('origin that does not confirm handling cannot acknowledge',async()=>{
  const x=await setup();
  try{
    await x.client.submit({council:x.fx.council,court:x.fx.court,
      handoff:x.fx.handoff,reply:'Unread local message.'});
    assert.equal((await x.client.receiveAndAcknowledge(async()=>false)).state,'NOT_ACKNOWLEDGED');
    assert.equal((await x.client.receiveAndAcknowledge(async()=>true)).state,'ACKNOWLEDGED');
  }finally{await x.cleanup();}
});
test('handler exception preserves unacknowledged delivery for retry',async()=>{
  const x=await setup();
  try{
    await x.client.submit({council:x.fx.council,court:x.fx.court,
      handoff:x.fx.handoff,reply:'Not safely handled.'});
    await assert.rejects(x.client.receiveAndAcknowledge(async()=>{throw Error('display failed');}),/display failed/);
    assert.equal((await x.client.receiveAndAcknowledge(async()=>true)).state,'ACKNOWLEDGED');
  }finally{await x.cleanup();}
});
test('client will not use an arbitrary remote address or leak keys',()=>{
  const fx=signedSetup();
  try{
    assert.throws(()=>createLocalCouncilBusClient({
      url:'https://malicious.example/',origin:ORIGIN,
      ingressPrivateKey:fx.keys.ingress.privateKey,
      originPrivateKey:fx.keys.origin.privateKey,busPublicKey:fx.keys.bus.publicKey,
    }),/LOCAL_URL_ONLY/);
  }finally{fx.cleanup();}
});
test('wrong Bus verifier key must stop message handling and ACK',async()=>{
  const x=await setup();
  try{
    await x.client.submit({council:x.fx.council,court:x.fx.court,
      handoff:x.fx.handoff,reply:'Security test.'});
    const fakeBus=generateKeyPairSync('ed25519');
    const wrong=createLocalCouncilBusClient({url:x.url,origin:ORIGIN,
      ingressPrivateKey:x.fx.keys.ingress.privateKey,
      originPrivateKey:x.fx.keys.origin.privateKey,
      busPublicKey:fakeBus.publicKey,now:()=>NOW});
    let handled=false;
    await assert.rejects(wrong.receiveAndAcknowledge(async()=>{handled=true;return true;}),/UNVERIFIED_BUS_SIGNATURE/);
    assert.equal(handled,false);
    assert.equal((await x.client.receiveAndAcknowledge(async()=>true)).state,'ACKNOWLEDGED');
  }finally{await x.cleanup();}
});

test('tampered plaintext reply is rejected before onMessage or ACK',async()=>{
  const x=await setup();
  try{
    await x.client.submit({council:x.fx.council,court:x.fx.court,
      handoff:x.fx.handoff,reply:'Original authorized response.'});
    const tamperFetch=async (url,options)=>{
      const response=await fetch(url,options);
      if(!url.endsWith('/v1/claim'))return response;
      const payload=await response.json();
      payload.message='An attacker changed the displayed answer.';
      return new Response(JSON.stringify(payload),{
        status:response.status,headers:{'content-type':'application/json'},
      });
    };
    const altered=createLocalCouncilBusClient({
      url:x.url,origin:ORIGIN,ingressPrivateKey:x.fx.keys.ingress.privateKey,
      originPrivateKey:x.fx.keys.origin.privateKey,busPublicKey:x.fx.keys.bus.publicKey,
      now:()=>NOW,fetchImpl:tamperFetch,
    });
    let handled=false;
    await assert.rejects(altered.receiveAndAcknowledge(async()=>{handled=true;return true;}),
      /BUS_CONTENT_MISMATCH/);
    assert.equal(handled,false);
    assert.equal((await x.client.receiveAndAcknowledge(async()=>true)).state,'ACKNOWLEDGED');
  }finally{await x.cleanup();}
});
test('missing or swapped signed-content attestation fails closed',async()=>{
  const x=await setup();
  try{
    await x.client.submit({council:x.fx.council,court:x.fx.court,
      handoff:x.fx.handoff,reply:'Another authenticated response.'});
    const incompleteFetch=async(url,options)=>{
      const response=await fetch(url,options);
      if(!url.endsWith('/v1/claim'))return response;
      const payload=await response.json();
      delete payload.signedContent;
      return new Response(JSON.stringify(payload),{status:response.status});
    };
    const missing=createLocalCouncilBusClient({
      url:x.url,origin:ORIGIN,ingressPrivateKey:x.fx.keys.ingress.privateKey,
      originPrivateKey:x.fx.keys.origin.privateKey,busPublicKey:x.fx.keys.bus.publicKey,
      now:()=>NOW,fetchImpl:incompleteFetch,
    });
    let callbacks=0;
    await assert.rejects(missing.receiveAndAcknowledge(async()=>{callbacks++;return true;}),
      /INVALID_SIGNED_CONTENT/);
    assert.equal(callbacks,0);
    assert.equal((await x.client.receiveAndAcknowledge(async()=>true)).state,'ACKNOWLEDGED');
  }finally{await x.cleanup();}
});
test('oversized Bus response fails before a message is handled',async()=>{
  const x=await setup();
  try{
    const inflatedFetch=async()=>new Response(JSON.stringify({payload:'x'.repeat(70000)}),
      {status:200,headers:{'content-type':'application/json'}});
    const huge=createLocalCouncilBusClient({
      url:x.url,origin:ORIGIN,ingressPrivateKey:x.fx.keys.ingress.privateKey,
      originPrivateKey:x.fx.keys.origin.privateKey,busPublicKey:x.fx.keys.bus.publicKey,
      now:()=>NOW,fetchImpl:inflatedFetch,
    });
    let handled=false;
    await assert.rejects(huge.receiveAndAcknowledge(async()=>{handled=true;return true;}),
      /OVERSIZED_BUS_RESPONSE/);
    assert.equal(handled,false);
  }finally{await x.cleanup();}
});
test('stalled HTTP requests abort within the configured bounded deadline',async()=>{
  const x=await setup();
  try{
    let aborted=false;
    const stalled=(_url,options)=>new Promise((_resolve,reject)=>{
      if(options.signal.aborted){aborted=true;reject(Error('ABORTED'));return;}
      options.signal.addEventListener('abort',()=>{
        aborted=true;reject(Error('ABORTED'));
      },{once:true});
    });
    const client=createLocalCouncilBusClient({
      url:x.url,origin:ORIGIN,ingressPrivateKey:x.fx.keys.ingress.privateKey,
      originPrivateKey:x.fx.keys.origin.privateKey,busPublicKey:x.fx.keys.bus.publicKey,
      now:()=>NOW,fetchImpl:stalled,timeoutMs:100,
    });
    await assert.rejects(client.receiveAndAcknowledge(async()=>true),/ABORTED/);
    assert.equal(aborted,true);
  }finally{await x.cleanup();}
});
