# Portable Council/Court export — source and boundaries

**Repository:** `jussray/ULTRATHINK-COUNCIL` — owns the executable portable Council/Court domain library.

**Input/source observation (historical):**
- Standalone parent: `jussray/ULTRATHINK-COUNCIL@643c0bb9ab5e1152a49814d6351c2ac1b68b81b2`.
- FCR current-main observation: `fd081f160a416c29ff8c60c18a8cfa571188a2d6`.
- FCR-owned Council flow design: `src/lib/councilRound.ts` with hop lineage, resume checkpoints and server-specific provider bridge.
- FCR-owned policy: `.control-room/COUNCIL.md`, `.control-room/COURT.md`, `.control-room/council-residency.contract.json`. Consult current FCR main on each use; the observed source SHA is provenance, not a permanently current ref.

## Exported executable ownership
- `src/council.mjs`: Council packet validation, independent-claim safeguards and Court evidence adjudication.
- `src/busHandoff.mjs`: immutable Court/Council-to-origin metadata, bounded to `PREPARED_NOT_SENT`.
- `src/round.mjs`: no-dependencies, port-injected zero-clipboard seat routing, content-linked chained answers, interruption/resume, Court composition and Bus handoff without false live evidence.
- `src/index.mjs` + `package.json`: explicit importable API and safe export map.
- `test/**/*.test.mjs`: positive and attacker-negative cases; `.github/workflows/conformance.yml` runs the entire strict test gate.

## Deliberate exclusions (FCR/Bus ownership)
This is a **complete portable Council/Court domain implementation**, not a copy of FCR's entire backend or an unreviewed migration. Its boundary intentionally does not export FCR-specific `src/http/routes/missions.ts`, Supabase client, founder authentication, application secrets, credential minting, operator/model API clients, release hooks, merge review issuer, or provider administration. Those capabilities stay with their owning runtime. Copying them here would violate the standalone authority/credential membrane and falsely imply deployed operation.

The actual Council Bus network, callback signing, idempotent persistence, verified external response identity and authenticated origin return are **not implemented by this source export**. Follow the current Council Bus owner and [ENG-7](https://linear.app/juss/issue/ENG-7/council-bus-reconcile-transport-and-return-findings-to-originating-ai), whose live status has not been verified. `provider:` labels and recomputed SHA-256 fingerprints do not authenticate providers or permit merge/deployment. `src/round.mjs` deliberately cannot convert local/simulated findings to independent live ones.

## End-to-end gate remaining
Authenticated originating AI request → Bus ingress/trace → exact caller/authorization → independently verified model-seat response → Court evidence ruling → trusted Bus delivery and receipt → originating AI ACK. A local conformance run is not an ACK. Until the actual owning runtime supplies each receipt, classify the chain `BLOCKED` or `UNVERIFIED`.

## Rollback
Revert the Council export PR. FCR code and runtime remain unchanged. No direct main mutation, model invocation, broadcast, production release or provider-policy change is performed as part of this export.
