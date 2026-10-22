/**
 * Portable, injected Council round executor.
 *
 * Adapted from the lineage/resume design in FCR src/lib/councilRound.ts.
 * This module has NO provider clients, HTTP listener, secrets, callbacks,
 * database, authenticated sender or delivery confirmation. It cannot prove
 * that a real Council participant answered.
 */
import {createHash, randomBytes} from 'node:crypto';
import {assembleCouncil, fingerprint, reviewCourt, verifyCouncil, verifyCourt} from './council.mjs';
import {prepareCouncilBusHandoff, verifyCouncilBusHandoff} from './busHandoff.mjs';

// v2 intentionally refuses v1 transcripts lacking per-attempt replay binding.
export const LOCAL_ROUND_CONTRACT = 'juss/portable-council-round@v2';
const ID = /^[a-z][a-z0-9-]{0,79}$/;
const SHA = /^[a-f0-9]{64}$/;
const ATTEMPT_ID = /^[a-f0-9]{32}$/;
const STATE = new Set(['UNVERIFIED', 'SIMULATED']);
const TEXT = value => typeof value === 'string' && value.trim().length > 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const requireCondition = (value, message) => {if (!value) throw new Error(message);};
const exact = (value, keys, label) => {
  requireCondition(object(value) && Object.keys(value).length === keys.length &&
    Object.keys(value).every(key => keys.includes(key)), `Invalid ${label} fields`);
};
// Budgeted local rounds defend the owning runtime from malformed/unbounded adapter data.
export const ROUND_LIMITS = Object.freeze({
  maxSeats: 8, maxGoalChars: 4096, maxSourceChars: 2048,
  maxTextChars: 32768, maxEvidenceRefs: 32, maxDissent: 16,
  maxEvidenceChars: 2048, maxDissentChars: 2048,
  defaultTimeoutMs: 30000, maxTimeoutMs: 60000,
});
const bounded = (value,max) => TEXT(value) && value.length <= max;
const boundedStrings = (value,maxCount,maxChars) =>
  Array.isArray(value) && value.length <= maxCount &&
  value.every(item => bounded(item,maxChars));
const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');
const hopFields = ['index','seat','attemptId','requestHash','contextHash','answer','answerHash',
  'responseHash','evidenceRefs','dissent','providerState','liveProviderEvidence','completedAt'];
const transcriptFields = ['contract','roundId','goal','sourceRef','seedHash','seats',
  'hops','state','nextSeatIndex','interruption','fingerprint'];

function checkConfig(input) {
  requireCondition(object(input), 'Round input required');
  requireCondition(typeof input.roundId === 'string' && ID.test(input.roundId), 'Invalid round ID');
  requireCondition(bounded(input.goal,ROUND_LIMITS.maxGoalChars) &&
    bounded(input.sourceRef,ROUND_LIMITS.maxSourceChars) &&
    bounded(input.seed,ROUND_LIMITS.maxTextChars), 'Missing or oversized goal/source/seed');
  requireCondition(Array.isArray(input.seats) && input.seats.length > 0 &&
    input.seats.length <= ROUND_LIMITS.maxSeats &&
    input.seats.every(seat => typeof seat === 'string' && ID.test(seat) && seat !== 'fcr') &&
    new Set(input.seats).size === input.seats.length, 'Invalid or duplicate Council seat');
  requireCondition(typeof input.dispatch === 'function', 'An explicitly supplied dispatch adapter is required');
  requireCondition(input.clock === undefined || typeof input.clock === 'function', 'Invalid clock');
  requireCondition(input.timeoutMs === undefined ||
    (Number.isSafeInteger(input.timeoutMs) && input.timeoutMs >= 1 &&
      input.timeoutMs <= ROUND_LIMITS.maxTimeoutMs), 'Invalid seat timeout');
}
function requestHash({roundId,goal,sourceRef,index,seat,contextHash,attemptId}) {
  return fingerprint({contract:'juss/portable-round-request@v2',roundId,goal,sourceRef,index,seat,contextHash,attemptId});
}
function responseHash(hop) {
  return fingerprint({contract:'juss/portable-round-response@v1',seat:hop.seat,
    requestHash:hop.requestHash,answerHash:hop.answerHash,evidenceRefs:hop.evidenceRefs,
    dissent:hop.dissent,providerState:hop.providerState});
}
function seal(state) {
  return {...state, fingerprint:fingerprint(state)};
}

/**
 * Verify local content integrity and deterministic lineage, NOT external
 * provider identity. Recomputable hashes can be forged by the writer.
 */
export function verifyLocalCouncilRound(transcript) {
  exact(transcript, transcriptFields, 'round');
  const {fingerprint:claimed, ...body} = transcript;
  requireCondition(typeof claimed === 'string' && claimed === fingerprint(body), 'Round fingerprint mismatch');
  requireCondition(body.contract === LOCAL_ROUND_CONTRACT, 'Unknown round contract');
  requireCondition(typeof body.roundId === 'string' && ID.test(body.roundId) &&
    bounded(body.goal,ROUND_LIMITS.maxGoalChars) &&
    bounded(body.sourceRef,ROUND_LIMITS.maxSourceChars) &&
    SHA.test(body.seedHash), 'Invalid round identity');
  requireCondition(Array.isArray(body.seats) && body.seats.length > 0 &&
    body.seats.length <= ROUND_LIMITS.maxSeats &&
    body.seats.every(seat => typeof seat === 'string' && ID.test(seat) && seat !== 'fcr') &&
    new Set(body.seats).size === body.seats.length, 'Invalid round seats');
  requireCondition(Array.isArray(body.hops) && body.hops.length <= body.seats.length, 'Invalid round hops');
  let contextHash = body.seedHash;
  const attempts = new Set();
  body.hops.forEach((hop, index) => {
    exact(hop, hopFields, 'hop');
    requireCondition(hop.index === index && hop.seat === body.seats[index] &&
      hop.contextHash === contextHash, 'Council hop lineage mismatch');
    requireCondition(typeof hop.attemptId === 'string' && ATTEMPT_ID.test(hop.attemptId) &&
      !attempts.has(hop.attemptId), 'Invalid or repeated Council attempt identity');
    attempts.add(hop.attemptId);
    requireCondition(hop.requestHash === requestHash({...body,index,seat:hop.seat,contextHash,attemptId:hop.attemptId}),
      'Council request hash mismatch');
    requireCondition(bounded(hop.answer,ROUND_LIMITS.maxTextChars) &&
      hop.answerHash === digest(hop.answer),
      'Council answer hash mismatch');
    requireCondition(boundedStrings(hop.evidenceRefs,ROUND_LIMITS.maxEvidenceRefs,ROUND_LIMITS.maxEvidenceChars) &&
      boundedStrings(hop.dissent,ROUND_LIMITS.maxDissent,ROUND_LIMITS.maxDissentChars) &&
      STATE.has(hop.providerState) && hop.liveProviderEvidence === false,
      'Council hop may not self-claim live provider status');
    requireCondition(bounded(hop.completedAt,48) && Number.isFinite(Date.parse(hop.completedAt)) &&
      hop.responseHash === responseHash(hop),
      'Council response hash mismatch');
    contextHash = hop.answerHash;
  });
  requireCondition(body.nextSeatIndex === body.hops.length, 'Round next seat mismatch');
  if (body.state === 'complete') {
    requireCondition(body.hops.length === body.seats.length && body.interruption === null,
      'Incomplete round claimed complete');
  } else if (body.state === 'interrupted') {
    requireCondition(body.hops.length < body.seats.length, 'Interrupted round exhausted its seats');
    exact(body.interruption, ['seatIndex','seat','reason'], 'interruption');
    requireCondition(body.interruption.seatIndex === body.hops.length &&
      body.interruption.seat === body.seats[body.hops.length] &&
      ['BLOCKED','FAILED','DISPATCH_ERROR','INVALID_RESPONSE','TIMED_OUT'].includes(body.interruption.reason),
      'Invalid interruption state');
  } else {
    throw new Error('Unknown round state');
  }
  return true;
}

/**
 * Executes ONLY the dispatch callback provided by its owning application.
 * No built-in network access, provider/identity proof, message delivery,
 * persistence, or authority is hidden in this library.
 */
export async function runLocalCouncilRound(input) {
  checkConfig(input);
  const previous = input.resumeFrom ?? null;
  if (previous) {
    verifyLocalCouncilRound(previous);
    requireCondition(previous.state === 'interrupted', 'Only an interrupted round can resume');
    requireCondition(previous.roundId === input.roundId && previous.goal === input.goal &&
      previous.sourceRef === input.sourceRef && previous.seedHash === digest(input.seed) &&
      JSON.stringify(previous.seats) === JSON.stringify(input.seats), 'Resume identity or roster mismatch');
    if (previous.interruption.reason === 'TIMED_OUT') {
      // The prior adapter could still be working despite AbortSignal. Never
      // silently send an additional provider request after an uncertain result.
      requireCondition(typeof input.verifyRetrySafety === 'function',
        'Timed-out retry requires trusted owner verification');
      let safe = false;
      try {
        safe = await input.verifyRetrySafety(Object.freeze({
          roundId:previous.roundId,sourceRef:previous.sourceRef,
          seat:previous.interruption.seat,priorFingerprint:previous.fingerprint,
          nextSeatIndex:previous.nextSeatIndex,
        })) === true;
      } catch {
        // Never persist an exception from the owning runtime; it might hold secrets.
      }
      requireCondition(safe, 'Timed-out retry is not cleared by owning runtime');
    }
  }
  const hops = previous ? structuredClone(previous.hops) : [];
  let context = hops.length ? hops[hops.length - 1].answer : input.seed;
  let interruption = null;
  for (let i = hops.length; i < input.seats.length; i++) {
    const seat = input.seats[i];
    const contextHash = digest(context);
    const expectedHash = hops.length ? hops[hops.length - 1].answerHash : digest(input.seed);
    requireCondition(contextHash === expectedHash, 'Round context changed across hops');
    // Generate a new, unpredictable identity for each actual dispatch attempt,
    // including a retry of the same seat after interruption.
    const attemptId = randomBytes(16).toString('hex');
    const hash = requestHash({roundId:input.roundId,goal:input.goal,
      sourceRef:input.sourceRef,index:i,seat,contextHash,attemptId});
    let response;
    const controller = new AbortController();
    const timedOut = Symbol('seat-timed-out');
    let timer;
    try {
      // Abort is cooperative: the owning adapter must honor signal to stop
      // any external request or prevent further cost after the deadline.
      const result = await Promise.race([
        Promise.resolve().then(() => input.dispatch(Object.freeze({
          roundId:input.roundId,seat,index:i,goal:input.goal,sourceRef:input.sourceRef,
          context,contextHash,attemptId,requestHash:hash,signal:controller.signal,
        }))),
        new Promise(resolve => {
          timer=setTimeout(() => {controller.abort();resolve(timedOut);},
            input.timeoutMs ?? ROUND_LIMITS.defaultTimeoutMs);
        }),
      ]);
      if (result === timedOut) {
        interruption={seatIndex:i,seat,reason:'TIMED_OUT'};
        break;
      }
      response=result;
    } catch {
      // Provider exceptions may contain secrets. Never persist their messages.
      interruption={seatIndex:i,seat,reason:'DISPATCH_ERROR'};
      break;
    } finally {
      clearTimeout(timer);
    }
    const validShape = object(response) &&
      Object.keys(response).every(key => ['status','requestHash','answer','evidenceRefs','dissent','providerState'].includes(key)) &&
      response.requestHash === hash &&
      ['completed','blocked','failed'].includes(response.status);
    if (!validShape) {
      interruption = {seatIndex:i,seat,reason:'INVALID_RESPONSE'};
      break;
    }
    if (response.status !== 'completed') {
      interruption = {seatIndex:i,seat,reason:response.status.toUpperCase()};
      break;
    }
    if (!bounded(response.answer,ROUND_LIMITS.maxTextChars) ||
      !boundedStrings(response.evidenceRefs ?? [],ROUND_LIMITS.maxEvidenceRefs,ROUND_LIMITS.maxEvidenceChars) ||
      !boundedStrings(response.dissent ?? [],ROUND_LIMITS.maxDissent,ROUND_LIMITS.maxDissentChars) ||
      !STATE.has(response.providerState)) {
      interruption = {seatIndex:i,seat,reason:'INVALID_RESPONSE'};
      break;
    }
    const hop = {
      index:i,seat,attemptId,requestHash:hash,contextHash,answer:response.answer,
      answerHash:digest(response.answer),responseHash:'',
      evidenceRefs:[...response.evidenceRefs ?? []],dissent:[...response.dissent ?? []],
      providerState:response.providerState,liveProviderEvidence:false,
      completedAt:(input.clock ?? (()=>new Date().toISOString()))(),
    };
    requireCondition(bounded(hop.completedAt,48) &&
      Number.isFinite(Date.parse(hop.completedAt)), 'Invalid local clock result');
    hop.responseHash=responseHash(hop);
    hops.push(hop);
    context=response.answer;
  }
  const transcript=seal({
    contract:LOCAL_ROUND_CONTRACT,roundId:input.roundId,goal:input.goal,
    sourceRef:input.sourceRef,seedHash:digest(input.seed),seats:[...input.seats],
    hops,state:interruption?'interrupted':'complete',nextSeatIndex:hops.length,interruption,
  });
  verifyLocalCouncilRound(transcript);
  return transcript;
}

/**
 * A locally assembled packet is never an independent provider witness.
 * Therefore its Court verdict is HOLD until evidence is authenticated by
 * an external trusted verifier. Bus output remains PREPARED_NOT_SENT.
 */
export function prepareLocalCourtHandoff({transcript,claims,strongestChallenge,dissent=[],origin,launchGate}) {
  verifyLocalCouncilRound(transcript);
  requireCondition(transcript.state==='complete', 'Court cannot publish an incomplete Council round');
  const council=assembleCouncil({
    roundId:transcript.roundId,goal:transcript.goal,sourceRef:transcript.sourceRef,
    independent:false,
    seats:transcript.hops.map(hop=>({
      id:hop.seat,finding:hop.answer,evidenceRefs:hop.evidenceRefs,
      dissent:hop.dissent,providerState:hop.providerState,
    })),
  });
  verifyCouncil(council);
  const court=reviewCourt(council,{claims,strongestChallenge,dissent,
    ...(launchGate===undefined?{}:{launchGate})});
  verifyCourt(council,court);
  const handoff=prepareCouncilBusHandoff({council,court,origin});
  verifyCouncilBusHandoff({council,court,handoff});
  requireCondition(court.verdict==='HOLD' && handoff.deliveryStatus==='PREPARED_NOT_SENT',
    'Locally produced output must remain on external verification HOLD');
  return {council,court,handoff};
}
