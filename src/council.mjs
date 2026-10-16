import { createHash } from 'node:crypto';

export const COUNCIL_CONTRACT = 'juss/ultrathink-council@v1';
export const COURT_CONTRACT = 'juss/founder-court-record@v1';
export const STATUSES = Object.freeze(['VERIFIED', 'INFERRED', 'UNKNOWN', 'BLOCKED', 'FAIL']);
export const WITNESSES = Object.freeze(['repository_source', 'ci_receipt', 'provider_readback', 'runtime_identity', 'browser_functional', 'browser_visual', 'independent_challenger', 'human_observation']);
const ID = /^[a-z][a-z0-9-]{0,79}$/;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function ensure(condition, message) { if (!condition) throw new Error(message); }
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  throw new Error('Unsupported fingerprint value');
}
export const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));

/** Pure, non-executing record of independent findings. Neither calls providers nor grants authority. */
export function assembleCouncil(input) {
  ensure(isObject(input), 'Council input required');
  ensure(ID.test(input.roundId ?? ''), 'Invalid round ID');
  ensure(typeof input.goal === 'string' && input.goal.trim(), 'Goal required');
  ensure(Array.isArray(input.seats) && input.seats.length > 0, 'At least one seat required');
  ensure(typeof input.sourceRef === 'string' && input.sourceRef.trim(), 'Source reference required');
  const ids = new Set();
  const findings = input.seats.map(seat => {
    ensure(isObject(seat) && ID.test(seat.id ?? ''), 'Invalid seat');
    ensure(!ids.has(seat.id), 'Repeated seat ID');
    ids.add(seat.id);
    ensure(typeof seat.finding === 'string' && seat.finding.trim(), 'Seat finding required');
    ensure(Array.isArray(seat.evidenceRefs), 'Evidence refs array required');
    ensure(Array.isArray(seat.dissent), 'Dissent array required');
    ensure(['UNVERIFIED', 'SIMULATED', 'EXTERNALLY_ATTESTED'].includes(seat.providerState), 'Invalid provider label');
    // Claimed provider evidence is never sufficient to establish LIVE status here.
    ensure(seat.evidenceRefs.every(ref => typeof ref === 'string' && ref.trim()), 'Invalid evidence ref');
    return copy({id:seat.id, finding:seat.finding, evidenceRefs:seat.evidenceRefs, dissent:seat.dissent, providerState:seat.providerState});
  });
  const record = {
    contract: COUNCIL_CONTRACT,
    roundId: input.roundId,
    sourceRef: input.sourceRef,
    goal: input.goal,
    findings,
    independent: input.independent === true,
    authority: {decisionOwner:'founder', grantsExecutionAuthority:false},
    transport: {owner:'Council Bus', tracking:'Linear ENG-7', deliveryProof:'NOT_ESTABLISHED'},
  };
  return {...record, fingerprint:fingerprint(record)};
}

export function verifyCouncil(packet) {
  ensure(isObject(packet) && packet.contract === COUNCIL_CONTRACT, 'Unknown Council contract');
  const {fingerprint: claimedHash, ...record} = packet;
  ensure(typeof claimedHash === 'string' && claimedHash === fingerprint(record), 'Council fingerprint mismatch');
  ensure(record.authority?.grantsExecutionAuthority === false, 'Council cannot authorize action');
  ensure(record.transport?.deliveryProof === 'NOT_ESTABLISHED', 'Transport proof cannot be self-minted');
  return true;
}

/** Court adjudicates evidence completeness, not authority. External witnesses still need verification. */
export function reviewCourt(packet, input) {
  verifyCouncil(packet);
  ensure(isObject(input) && Array.isArray(input.claims) && input.claims.length, 'Claims required');
  ensure(typeof input.strongestChallenge === 'string' && input.strongestChallenge.trim(), 'Independent cross-examination required');
  ensure(Array.isArray(input.dissent), 'Dissent required');
  const gaps = [];
  if (!packet.independent) gaps.push('Council findings not confirmed independent');
  for (const claim of input.claims) {
    ensure(isObject(claim) && ID.test(claim.id ?? '') && STATUSES.includes(claim.status), 'Invalid claim');
    ensure(Array.isArray(claim.witnesses), 'Witness array required');
    for (const witness of claim.witnesses) {
      ensure(WITNESSES.includes(witness.class), 'Unrecognized witness class');
      ensure(typeof witness.ref === 'string' && witness.ref.trim(), 'Witness ref required');
      ensure(typeof witness.root === 'string' && witness.root.trim(), 'Witness root required');
    }
    if (claim.status !== 'VERIFIED') gaps.push(`${claim.id}: ${claim.status}`);
    if (claim.status === 'VERIFIED' && !claim.witnesses.length) gaps.push(`${claim.id}: no witnesses`);
    if (claim.independent === true && new Set(claim.witnesses.map(w => w.root)).size < 2) gaps.push(`${claim.id}: repeated source not independent`);
  }
  const launch = input.launchGate;
  if (launch !== undefined) {
    ensure(isObject(launch), 'Invalid launch gate');
    for (const key of ['destinationIdentity', 'functionalRuntime', 'visualCanon']) {
      if (launch[key] !== 'VERIFIED') gaps.push(`launch ${key}: ${launch[key] ?? 'UNKNOWN'}`);
    }
    if (launch.measurementGoal === true && launch.campaignAttribution !== 'VERIFIED') gaps.push('launch campaignAttribution not verified');
  }
  const verdict = gaps.length ? 'HOLD' : 'READY_FOR_EXTERNAL_VERIFICATION';
  const record = {
    contract: COURT_CONTRACT,
    councilRound: packet.roundId,
    councilFingerprint: packet.fingerprint,
    verdict,
    gaps,
    witnesses:copy(input.claims),
    dissent:copy(input.dissent),
    strongestChallenge:input.strongestChallenge,
    authority:{decisionOwner:'founder', grantsExecutionAuthority:false},
    limits:['No external evidence fetched here', 'No live-provider identity verified here', 'No merge, deploy, publish, spend, delete, or cross-project writes authorized'],
  };
  return {...record, fingerprint:fingerprint(record)};
}