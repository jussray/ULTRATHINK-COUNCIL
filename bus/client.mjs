/**
 * Loopback-only clients for the standalone Council Bus reference.
 * A host application's onMessage callback must confirm handling before ACK.
 * This is NOT a ChatGPT connector or evidence of human-visible delivery.
 */
import {createPrivateKey,createPublicKey,randomBytes,sign,verify} from 'node:crypto';
import {fingerprint} from '../src/council.mjs';
import {verifyCouncilBusHandoff} from '../src/busHandoff.mjs';

const PUB='juss/council-bus-submit@v1';
const CLAIM='juss/council-bus-claim@v1';
const ACK='juss/council-origin-ack@v1';
const DELIVERY='juss/council-bus-delivery@v1';
const B64=/^[A-Za-z0-9+/]{86}==$/;
const SHA=/^[a-f0-9]{64}$/;
const ORIGIN_FIELDS=['agent','route','threadId','correlationId'];
const DELIVERY_FIELDS=['contract','handoffFingerprint','idempotencyKey','origin','state','deliveredAt','signature'];
const EXACT=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===keys.length&&Object.keys(value).every(x=>keys.includes(x));
const assert=(ok,code)=>{if(!ok)throw Error(code);};
const signRecord=(obj,key)=>({...obj,signature:sign(null,Buffer.from(fingerprint(obj),'hex'),key).toString('base64')});
function getKey(raw,kind){
  try{
    const k=kind==='private'?(raw?.type==='private'?raw:createPrivateKey(raw)):
      (raw?.type==='public'?raw:createPublicKey(raw));
    assert(k.asymmetricKeyType==='ed25519','KEY_ALGORITHM_NOT_ED25519');
    return k;
  }catch{throw Error('INVALID_SIGNING_KEY');}
}
function equalOrigin(a,b){return EXACT(a,ORIGIN_FIELDS)&&EXACT(b,ORIGIN_FIELDS)&&
  ORIGIN_FIELDS.every(k=>a[k]===b[k]);}
function canonicalStamp(now){const n=now();assert(Number.isSafeInteger(n)&&n>=0,'INVALID_CLOCK');return new Date(n).toISOString();}
function checkSignedBusReceipt(record,key,expectedHandoff,origin,now){
  assert(EXACT(record,DELIVERY_FIELDS),'INVALID_BUS_RECEIPT');
  assert(record.contract===DELIVERY&&record.state==='DELIVERED'&&
    record.handoffFingerprint===expectedHandoff.fingerprint&&
    record.idempotencyKey===expectedHandoff.idempotencyKey&&
    equalOrigin(record.origin,origin),'BUS_RECEIPT_MISMATCH');
  assert(typeof record.signature==='string'&&B64.test(record.signature),'INVALID_BUS_SIGNATURE');
  const {signature,...data}=record,signatureBytes=Buffer.from(signature,'base64');
  assert(signatureBytes.length===64&&signatureBytes.toString('base64')===signature,'INVALID_BUS_SIGNATURE');
  assert(verify(null,Buffer.from(fingerprint(data),'hex'),key,signatureBytes),'UNVERIFIED_BUS_SIGNATURE');
  const when=Date.parse(record.deliveredAt),clock=now();
  assert(typeof record.deliveredAt==='string'&&Number.isFinite(when)&&
    new Date(when).toISOString()===record.deliveredAt&&
    Number.isSafeInteger(clock)&&Math.abs(clock-when)<=300000,
    'STALE_BUS_DELIVERY');
}
export function createLocalCouncilBusClient({
  url,origin,ingressPrivateKey,originPrivateKey,busPublicKey,
  now=()=>Date.now(),fetchImpl=globalThis.fetch,
}){
  const u=new URL(url);
  assert(u.protocol==='http:'&&u.hostname==='127.0.0.1'&&u.pathname==='/'&&
    !u.username&&!u.password&&!u.search&&!u.hash,'LOCAL_URL_ONLY');
  assert(equalOrigin(origin,origin),'INVALID_ORIGIN');
  assert(ORIGIN_FIELDS.every(k=>typeof origin[k]==='string'&&
    /^[a-z][a-z0-9-]{0,79}$/.test(origin[k])),'INVALID_ORIGIN');
  assert(typeof now==='function'&&typeof fetchImpl==='function','INVALID_CLIENT_CONFIGURATION');
  const ingress=getKey(ingressPrivateKey,'private');
  const originSigner=getKey(originPrivateKey,'private');
  const busVerifier=getKey(busPublicKey,'public');
  assert(!createPublicKey(ingress).export({format:'der',type:'spki'}).equals(
    createPublicKey(originSigner).export({format:'der',type:'spki'})),'DISTINCT_KEYS_REQUIRED');
  async function post(path,payload){
    const response=await fetchImpl(u.href.replace(/\/$/,'')+path,{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),
      redirect:'error',
    });
    assert(response.ok,'BUS_HTTP_'+response.status);
    const parsed=await response.json();
    assert(parsed&&typeof parsed==='object'&&!Array.isArray(parsed),'INVALID_BUS_RESPONSE');
    return parsed;
  }
  async function submit({council,court,handoff,reply}){
    verifyCouncilBusHandoff({council,court,handoff});
    assert(equalOrigin(handoff.origin,origin),'ORIGIN_MISMATCH');
    assert(typeof reply==='string'&&reply.trim()&&reply.length<=8000,'INVALID_REPLY');
    const payload={contract:PUB,council,court,handoff,reply,issuedAt:canonicalStamp(now)};
    const result=await post('/v1/publish',signRecord(payload,ingress));
    assert(result.handoffFingerprint===handoff.fingerprint&&
      ['QUEUED','DELIVERY_ATTEMPTED','ACKNOWLEDGED'].includes(result.state),
      'INVALID_PUBLISH_RECEIPT');
    return result;
  }
  async function receiveAndAcknowledge(onMessage){
    assert(typeof onMessage==='function','MESSAGE_HANDLER_REQUIRED');
    const claim=signRecord({contract:CLAIM,origin:{...origin},issuedAt:canonicalStamp(now),
      nonce:randomBytes(16).toString('hex')},originSigner);
    const response=await post('/v1/claim',claim);
    if(response.state==='EMPTY')return Object.freeze({state:'EMPTY'});
    assert(response.state==='DELIVERY_ATTEMPTED'&&
      typeof response.message==='string'&&response.message.trim()&&response.message.length<=8000&&
      response.handoff&&typeof response.handoff==='object'&&SHA.test(response.handoff.fingerprint),
      'INVALID_DELIVERY_ENVELOPE');
    const {fingerprint:claimed,...unsigned}=response.handoff;
    assert(fingerprint(unsigned)===claimed&&response.handoff.deliveryStatus==='PREPARED_NOT_SENT'&&
      response.handoff.authority?.grantsExecutionAuthority===false,'INVALID_HANDOFF');
    checkSignedBusReceipt(response.delivery,busVerifier,response.handoff,origin,now);
    // A display or message-store failure MUST leave the delivery unacknowledged.
    const handled=await onMessage(Object.freeze({
      message:response.message,handoff:response.handoff,delivery:response.delivery,
    }));
    if(handled!==true)return Object.freeze({state:'NOT_ACKNOWLEDGED'});
    const ackPayload={contract:ACK,handoffFingerprint:response.handoff.fingerprint,
      deliveryFingerprint:fingerprint(response.delivery),origin:{...origin},
      state:'ACKNOWLEDGED',acknowledgedAt:canonicalStamp(now)};
    const result=await post('/v1/ack',signRecord(ackPayload,originSigner));
    assert(result.state==='ACKNOWLEDGED'&&
      result.handoffFingerprint===response.handoff.fingerprint,'INVALID_ACK_CONFIRMATION');
    return Object.freeze({state:'ACKNOWLEDGED',handoffFingerprint:response.handoff.fingerprint});
  }
  return Object.freeze({submit,receiveAndAcknowledge});
}
