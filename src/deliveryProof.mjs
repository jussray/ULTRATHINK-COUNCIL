/**
 * Verify signed receipts from the EXTERNAL Council Bus and originating AI.
 *
 * This is a read-only verifier; it does not send, sign, invoke providers,
 * persist dedup state, or authenticate transport sessions.
 * Trusted public keys and the clock must come from the hosting runtime.
 */
import {createPublicKey, verify as verifySignature} from 'node:crypto';
import {fingerprint} from './council.mjs';
import {verifyCouncilBusHandoff} from './busHandoff.mjs';

export const BUS_DELIVERY_RECEIPT_CONTRACT = 'juss/council-bus-delivery@v1';
export const ORIGIN_ACK_RECEIPT_CONTRACT = 'juss/council-origin-ack@v1';
export const DEFAULT_RECEIPT_MAX_AGE_MS = 10 * 60 * 1000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const SIGNATURE_B64 = /^[A-Za-z0-9+/]{86}==$/;
const DELIVERY_FIELDS = ['contract','handoffFingerprint','idempotencyKey','origin',
  'state','deliveredAt','signature'];
const ACK_FIELDS = ['contract','handoffFingerprint','deliveryFingerprint','origin',
  'state','acknowledgedAt','signature'];
const ORIGIN_FIELDS = ['agent','route','threadId','correlationId'];

const plain = value => value !== null && typeof value === 'object' &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const requireFact = (value, message) => { if (!value) throw new Error(message); };
function exact(value, fields, label) {
  requireFact(plain(value) && Object.keys(value).length === fields.length &&
    Object.keys(value).every(name => fields.includes(name)), 'Invalid '+label+' fields');
}
function ensureOrigin(value, expected) {
  exact(value, ORIGIN_FIELDS, 'origin');
  for (const name of ORIGIN_FIELDS) {
    requireFact(value[name] === expected[name], 'Origin identity mismatch');
  }
}
function verifiedKey(key, label) {
  let parsed;
  try { parsed = key?.type === 'public' && key?.asymmetricKeyType === 'ed25519' ? key : createPublicKey(key); } catch { throw new Error('Invalid '+label+' public key'); }
  requireFact(parsed.asymmetricKeyType === 'ed25519', 'Unsupported '+label+' key algorithm');
  return parsed;
}
function verifyAttestation(record, key, label) {
  requireFact(typeof record.signature === 'string' &&
    SIGNATURE_B64.test(record.signature), 'Invalid '+label+' signature encoding');
  const signature = Buffer.from(record.signature, 'base64');
  requireFact(signature.length === 64 &&
    signature.toString('base64') === record.signature, 'Invalid '+label+' signature bytes');
  const {signature:excluded, ...payload} = record;
  const digest = Buffer.from(fingerprint(payload), 'hex');
  requireFact(verifySignature(null,digest,key,signature), 'Unverified '+label+' signature');
}
function checkTime(stamp, now, maxAgeMs, label) {
  requireFact(typeof stamp === 'string' && stamp.length <= 40 &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(stamp),
    'Invalid '+label+' timestamp');
  const parsed = Date.parse(stamp);
  requireFact(Number.isFinite(parsed) && new Date(parsed).toISOString() === stamp,
    'Invalid '+label+' timestamp');
  requireFact(parsed >= now-maxAgeMs && parsed <= now+MAX_FUTURE_SKEW_MS,
    'Stale or future '+label+' receipt');
  return parsed;
}

/**
 * Positive verification means only: two differently keyed signers produced
 * unexpired, linked delivery and origin-ack records for the exact handoff.
 * It does NOT prove model identity, message display, user read, response text,
 * funding authority, production outcome, or provider independence.
 */
export function verifyCouncilDeliveryEvidence({
  council, court, handoff, delivery, ack, busPublicKey, originPublicKey,
  now=Date.now(), maxAgeMs=DEFAULT_RECEIPT_MAX_AGE_MS,
}) {
  verifyCouncilBusHandoff({council,court,handoff});
  requireFact(Number.isSafeInteger(now) && now >= 0, 'Invalid trusted time');
  requireFact(Number.isSafeInteger(maxAgeMs) && maxAgeMs >= 1000 &&
    maxAgeMs <= MAX_AGE_MS, 'Invalid receipt age policy');

  const busKey = verifiedKey(busPublicKey,'Bus');
  const originKey = verifiedKey(originPublicKey,'origin');
  requireFact(!busKey.export({type:'spki',format:'der'}).equals(
    originKey.export({type:'spki',format:'der'})),
    'Bus and originating agent require distinct trusted keys');

  exact(delivery, DELIVERY_FIELDS, 'Bus delivery');
  requireFact(delivery.contract === BUS_DELIVERY_RECEIPT_CONTRACT &&
    delivery.state === 'DELIVERED' &&
    delivery.handoffFingerprint === handoff.fingerprint &&
    delivery.idempotencyKey === handoff.idempotencyKey,
    'Bus delivery not bound to this handoff');
  ensureOrigin(delivery.origin,handoff.origin);
  const deliveryTime = checkTime(delivery.deliveredAt,now,maxAgeMs,'delivery');
  verifyAttestation(delivery,busKey,'Bus delivery');

  exact(ack, ACK_FIELDS, 'origin acknowledgment');
  requireFact(ack.contract === ORIGIN_ACK_RECEIPT_CONTRACT &&
    ack.state === 'ACKNOWLEDGED' &&
    ack.handoffFingerprint === handoff.fingerprint &&
    ack.deliveryFingerprint === fingerprint(delivery),
    'Origin acknowledgment not bound to verified delivery');
  ensureOrigin(ack.origin,handoff.origin);
  const ackTime = checkTime(ack.acknowledgedAt,now,maxAgeMs,'acknowledgment');
  requireFact(ackTime >= deliveryTime, 'Origin acknowledgment predates delivery');
  verifyAttestation(ack,originKey,'origin acknowledgment');

  return Object.freeze({
    contract:'juss/council-delivery-evidence-result@v1',
    state:'SIGNED_DELIVERY_AND_ORIGIN_ACK_VERIFIED',
    handoffFingerprint:handoff.fingerprint,
    deliveryFingerprint:fingerprint(delivery),
    originAcknowledgmentFingerprint:fingerprint(ack),
    courtVerdict:court.verdict,
    grantsExecutionAuthority:false,
    providerInvocationVerified:false,
  });
}
