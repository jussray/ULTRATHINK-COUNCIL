/**
 * Standalone local Council Bus reference runtime.
 * This package deliberately does NOT replace the shared Council Bus owner
 * or grant permissions to FCR, any model provider, or a merge/deploy agent.
 * It stores private replies in a locally protected SQLite file.
 */
import {DatabaseSync} from 'node:sqlite';
import {createPublicKey, createPrivateKey, createHash, sign, verify} from 'node:crypto';
import {mkdirSync, statSync, chmodSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fingerprint} from '../src/council.mjs';
import {verifyCouncilBusHandoff} from '../src/busHandoff.mjs';

const SUBMIT='juss/council-bus-submit@v1';
const CLAIM='juss/council-bus-claim@v1';
const DELIVERY='juss/council-bus-delivery@v1';
const ACK='juss/council-origin-ack@v1';
const CONTENT='juss/council-bus-content@v1';
const hashMessage=message=>createHash('sha256').update(message,'utf8').digest('hex');
const MAX_CLOCK_DRIFT=5*60*1000;
const DIGEST=/^[a-f0-9]{64}$/;
const NONCE=/^[a-f0-9]{32,64}$/;
const B64=/^[A-Za-z0-9+/]{86}==$/;
const MAX_REPLY=8000;
const MAX_QUEUED=1000;
function fail(code){throw new BusFault(code);}
export class BusFault extends Error {
  constructor(code){super(code);this.name='BusFault';this.code=code;}
}
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
function exact(x,keys,code){
  if(!object(x)||Object.keys(x).length!==keys.length||
    !Object.keys(x).every(key=>keys.includes(key)))fail(code);
}
function parsedKey(value,type){
  try {
    const key=type==='private'?
      (value?.type==='private'?value:createPrivateKey(value)):
      (value?.type==='public'?value:createPublicKey(value));
    if(key.asymmetricKeyType!=='ed25519')fail('BAD_KEY');
    return key;
  } catch {fail('BAD_KEY');}
}
function signedPayload(payload,key){
  return {...payload,signature:sign(null,Buffer.from(fingerprint(payload),'hex'),key).toString('base64')};
}
function checkSigned(record,key){
  if(!object(record)||typeof record.signature!=='string'||!B64.test(record.signature))fail('UNAUTHENTICATED');
  const {signature,...content}=record;
  const sig=Buffer.from(signature,'base64');
  if(sig.length!==64||sig.toString('base64')!==signature||
    !verify(null,Buffer.from(fingerprint(content),'hex'),key,sig))fail('UNAUTHENTICATED');
  return content;
}
function stamp(value,now){
  if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value))fail('STALE_OR_INVALID_TIME');
  const n=Date.parse(value);
  if(!Number.isFinite(n)||new Date(n).toISOString()!==value||Math.abs(now-n)>MAX_CLOCK_DRIFT)fail('STALE_OR_INVALID_TIME');
  return n;
}
function originKey(origin){
  exact(origin,['agent','route','threadId','correlationId'],'INVALID_ORIGIN');
  for(const v of Object.values(origin))if(typeof v!=='string'||!/^[a-z][a-z0-9-]{0,79}$/.test(v))fail('INVALID_ORIGIN');
  return JSON.stringify(origin);
}
function messageSize(x,max){
  if(typeof x!=='string'||x.trim().length===0||x.length>max)fail('INVALID_MESSAGE');
}
function begin(db,action){
  db.exec('BEGIN IMMEDIATE');
  try {const result=action();db.exec('COMMIT');return result;}
  catch(e){db.exec('ROLLBACK');throw e;}
}
export function createLocalCouncilBus({
  dbPath,ingressPublicKey,originPublicKey,busPrivateKey,
  allowedOriginAgent,allowedOriginRoute,now=()=>Date.now(),
}) {
  if(typeof dbPath!=='string'||!dbPath.trim()||dbPath===':memory:')fail('INVALID_DB_PATH');
  if(typeof allowedOriginAgent!=='string'||typeof allowedOriginRoute!=='string'||
    !/^[a-z][a-z0-9-]{0,79}$/.test(allowedOriginAgent)||
    !/^[a-z][a-z0-9-]{0,79}$/.test(allowedOriginRoute))fail('INVALID_ORIGIN_CONFIG');
  if(typeof now!=='function')fail('INVALID_CLOCK');
  const ingress=parsedKey(ingressPublicKey,'public');
  const origin=parsedKey(originPublicKey,'public');
  const signer=parsedKey(busPrivateKey,'private');
  const busPub=createPublicKey(signer);
  const bytes=k=>k.export({format:'der',type:'spki'});
  if(bytes(ingress).equals(bytes(origin))||bytes(ingress).equals(bytes(busPub))||
    bytes(origin).equals(bytes(busPub)))fail('KEYS_MUST_BE_DISTINCT');
  const path=resolve(dbPath);
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  if(process.platform!=='win32' && (statSync(dirname(path)).mode & 0o077)!==0)fail('UNSAFE_STORAGE_DIRECTORY');
  const db=new DatabaseSync(path);
  chmodSync(path,0o600);
  db.exec(`PRAGMA busy_timeout=2000;
    PRAGMA journal_mode=DELETE;
    CREATE TABLE IF NOT EXISTS items(
      fingerprint TEXT PRIMARY KEY, idempotency TEXT NOT NULL UNIQUE,
      origin TEXT NOT NULL, handoff TEXT NOT NULL, message TEXT NOT NULL,
      created INTEGER NOT NULL, delivery TEXT, ack TEXT
    );
    CREATE TABLE IF NOT EXISTS claims(nonce TEXT PRIMARY KEY, received INTEGER NOT NULL);`);
  const select=db.prepare('SELECT * FROM items WHERE fingerprint=?');
  const lookup=db.prepare('SELECT * FROM items WHERE idempotency=?');
  const insert=db.prepare('INSERT INTO items(fingerprint,idempotency,origin,handoff,message,created) VALUES(?,?,?,?,?,?)');
  const count=db.prepare('SELECT COUNT(*) AS count FROM items WHERE ack IS NULL');
  const next=db.prepare('SELECT * FROM items WHERE origin=? AND ack IS NULL ORDER BY created ASC,fingerprint ASC LIMIT 1');
  const deliverySave=db.prepare('UPDATE items SET delivery=? WHERE fingerprint=? AND ack IS NULL');
  const ackSave=db.prepare('UPDATE items SET ack=? WHERE fingerprint=? AND ack IS NULL');
  const nonceInsert=db.prepare('INSERT INTO claims(nonce,received) VALUES(?,?)');
  const nonceCleanup=db.prepare('DELETE FROM claims WHERE received<?');
  function current(){const n=now();if(!Number.isSafeInteger(n)||n<0)fail('INVALID_CLOCK');return n;}
  function isOrigin(x){const key=originKey(x);if(x.agent!==allowedOriginAgent||x.route!==allowedOriginRoute)fail('ORIGIN_NOT_AUTHORIZED');return key;}
  function publish(submission){
    exact(submission,['contract','council','court','handoff','reply','issuedAt','signature'],'INVALID_SUBMISSION');
    if(submission.contract!==SUBMIT)fail('INVALID_SUBMISSION');
    checkSigned(submission,ingress);
    const time=current();
    stamp(submission.issuedAt,time);
    messageSize(submission.reply,MAX_REPLY);
    verifyCouncilBusHandoff({council:submission.council,court:submission.court,handoff:submission.handoff});
    const key=isOrigin(submission.handoff.origin);
    const handoff=submission.handoff;
    if(handoff.deliveryStatus!=='PREPARED_NOT_SENT'||handoff.authority.grantsExecutionAuthority!==false||
      !DIGEST.test(handoff.fingerprint)||!DIGEST.test(handoff.idempotencyKey))fail('INVALID_HANDOFF');
    return begin(db,()=>{
      const existing=select.get(handoff.fingerprint);
      if(existing){
        if(existing.idempotency!==handoff.idempotencyKey||existing.message!==submission.reply||
          existing.origin!==key||existing.handoff!==JSON.stringify(handoff))fail('CONFLICTING_HANDOFF');
        return {state:existing.ack?'ACKNOWLEDGED':existing.delivery?'DELIVERY_ATTEMPTED':'QUEUED',handoffFingerprint:handoff.fingerprint,duplicate:true};
      }
      if(lookup.get(handoff.idempotencyKey))fail('CONFLICTING_HANDOFF');
      if(count.get().count>=MAX_QUEUED)fail('QUEUE_CAPACITY');
      insert.run(handoff.fingerprint,handoff.idempotencyKey,key,JSON.stringify(handoff),submission.reply,time);
      return {state:'QUEUED',handoffFingerprint:handoff.fingerprint,duplicate:false};
    });
  }
  function claim(request){
    exact(request,['contract','origin','issuedAt','nonce','signature'],'INVALID_CLAIM');
    if(request.contract!==CLAIM||typeof request.nonce!=='string'||!NONCE.test(request.nonce))fail('INVALID_CLAIM');
    checkSigned(request,origin);
    const time=current();
    stamp(request.issuedAt,time);
    const key=isOrigin(request.origin);
    return begin(db,()=>{
      nonceCleanup.run(time-MAX_CLOCK_DRIFT);
      try{nonceInsert.run(request.nonce,time);}catch{fail('REPLAYED_CLAIM');}
      const row=next.get(key);
      if(!row)return {state:'EMPTY'};
      let delivered=row.delivery===null?null:JSON.parse(row.delivery);
      // An unacknowledged delivery can outlive the client's 5-minute
      // receipt freshness window. Renew its signed receipt on a new,
      // authenticated claim rather than leaving the queue unrecoverable.
      // An older pending ACK then becomes invalid, requiring origin retry.
      if(!delivered||time-Date.parse(delivered.deliveredAt)>MAX_CLOCK_DRIFT){
        const payload={contract:DELIVERY,handoffFingerprint:row.fingerprint,
          idempotencyKey:row.idempotency,origin:JSON.parse(row.origin),state:'DELIVERED',
          deliveredAt:new Date(time).toISOString()};
        delivered=signedPayload(payload,signer);
        deliverySave.run(JSON.stringify(delivered),row.fingerprint);
      }
      // DELIVERED in this signed record means claimed by the origin endpoint;
      // without a separately signed origin ACK the external outcome is uncertain.
      // The signed delivery receipt is metadata only. Sign the actual reply's
      // digest against that receipt; a modified HTTP response must not become
      // an accepted answer or trigger an origin ACK.
      const signedContent=signedPayload({
        contract:CONTENT,handoffFingerprint:row.fingerprint,
        deliveryFingerprint:fingerprint(delivered),origin:JSON.parse(row.origin),
        messageHash:hashMessage(row.message),state:'CONTENT_BOUND',
      },signer);
      return {state:'DELIVERY_ATTEMPTED',delivery:delivered,signedContent,
        message:row.message,handoff:JSON.parse(row.handoff)};
    });
  }
  function acknowledge(receipt){
    exact(receipt,['contract','handoffFingerprint','deliveryFingerprint','origin','state','acknowledgedAt','signature'],'INVALID_ACK');
    if(receipt.contract!==ACK||receipt.state!=='ACKNOWLEDGED'||
      !DIGEST.test(receipt.handoffFingerprint)||!DIGEST.test(receipt.deliveryFingerprint))fail('INVALID_ACK');
    checkSigned(receipt,origin);
    const time=current();
    stamp(receipt.acknowledgedAt,time);
    const key=isOrigin(receipt.origin);
    return begin(db,()=>{
      const row=select.get(receipt.handoffFingerprint);
      if(!row||row.origin!==key||!row.delivery)fail('UNKNOWN_DELIVERY');
      const delivery=JSON.parse(row.delivery);
      if(receipt.deliveryFingerprint!==fingerprint(delivery))fail('ACK_DELIVERY_MISMATCH');
      if(Date.parse(receipt.acknowledgedAt)<Date.parse(delivery.deliveredAt))fail('ACK_BEFORE_DELIVERY');
      const stored=JSON.stringify(receipt);
      if(row.ack){
        if(row.ack!==stored)fail('ACK_CONFLICT');
        return {state:'ACKNOWLEDGED',idempotent:true,handoffFingerprint:row.fingerprint};
      }
      ackSave.run(stored,row.fingerprint);
      return {state:'ACKNOWLEDGED',idempotent:false,handoffFingerprint:row.fingerprint};
    });
  }
  function status(){return {implementation:'LOCAL_SINGLE_ORIGIN_REFERENCE',pending:count.get().count};}
  function close(){db.close();}
  return Object.freeze({publish,claim,acknowledge,status,close});
}
