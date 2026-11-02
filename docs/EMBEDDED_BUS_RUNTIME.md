# Embedded Council Bus runtime — opt-in contract

**Branch scope:** The Council package exports an executable, injected return-to-origin adapter. This does not copy or replace the authoritative Council Bus transport service. Existing Council/Court evidence semantics and existing PREPARED_NOT_SENT handoff remain unchanged.

## Usage and execution requirements

Import runEmbeddedCouncilBus from @jussray/ultrathink-council/embedded-bus or the package root. Pass a verified Council packet, verified Court record, the original Council Bus handoff, an opaque caller reference, and **all** required ports from the owning authenticated service.

Ports: enabled(stage), authenticate({caller,origin}), authorize({principal,origin,scope}), journal.claimOnce(...), journal.finish(...), journal.read(key), deliver({route,agent,threadId,packet,signal}), verifyAck(...). The owner must implement cryptographic identity/authentication, tenant-scoped route allowlists, durable atomic deduplication, signed callback validation, reliable persistence, retries and timeouts. Only the owner manages credentials and remote networking.

Stages **ingress / dispatch / egress** all require a server-owned enabled(stage) result **exactly true** before action. No shipped flag provider exists and missing ports fail closed. Checking a flag once cannot terminate a callback that has already started; operator must additionally revoke/suspend upstream delivery and apply deadlines/circuit breakers. An aborted signal is only advisory to external adapters.

## Security semantics

- Council/Court policies are re-verified locally; Court HOLD blocks delivery.
- Even READY_FOR_EXTERNAL_VERIFICATION does **not** mean VERIFIED or authorize consequential changes.
- Bus sends metadata only. It never forwards raw private transcripts or Council findings and it never treats a hash as authentication.
- Journal must atomically claim a key before delivery; a duplicate never re-sends. A crashed/failed send may remain PENDING and requires independent operator reconciliation. Do **not** blindly reset idempotency keys.
- An ACK must match the expected key, correlation and a bounded receipt ID, pass independently supplied verification and match persisted readback. The return status ACK_REPORTED_BY_TRUSTED_PORT describes observed adapter testimony, NOT independently verified production delivery.
- Does not install actual HTTP endpoints, scheduled runners, remote providers, persistence or secrets in Council. The owning runtime remains responsible for operationalization.

## Acceptance

Run npm test / npm run check. Then verify externally in the owner runtime: authenticated origin → allowlisted route → Court ruling → durable claim → callback to the original AI → independently signed ACK → persisted readback. Test disabled stages, concurrency, kill-switch races, replay, fraudulent ACK, cross-tenant denied routes, budget/timeout recovery and rollback. Report source green separately from live path.

**Governance:** Juss OS first; permissions and founder acceptance remain outside Council. No new PR, merge, deployment, or irreversible action implied by this branch.
