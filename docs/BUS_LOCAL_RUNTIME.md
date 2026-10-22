# Local Council Bus runtime — self-hostable reference, NOT production

This is a **runnable single-origin/local-only transport reference** living under `bus/` until a separately approved neutral Council Bus repository and backing are selected. It is not the physically approved shared Council federation from FCR's `.control-room/council-residency.contract.json`, whose backing remains undecided. It neither overrides FCR founder authority nor publishes to ChatGPT or any external agent.

## Functional source flow

1. `POST /v1/publish`: A trusted producer submits the canonical Council, Court, and `PREPARED_NOT_SENT` handoff, a bounded reply summary, and an Ed25519 signature over the whole submission. The service verifies the signature with a provisioned **ingress** public key and verifies the Council/Court/handoff binding before committing an idempotent SQLite row.
2. `POST /v1/claim`: The configured originating agent makes a fresh Ed25519-signed claim with the exact symbolic `origin` tuple and unique nonce. The service atomically records the claim to prevent replay, creates or reuses the immutable Bus-signed delivery receipt, and returns the associated reply only to the authorized origin. This is **DELIVERY_ATTEMPTED**, not proof of a user-visible answer.
3. `POST /v1/ack`: The originating agent signs an acknowledgement linked to the full Bus delivery receipt fingerprint. The service verifies its configured, distinct origin public key, enforces ordering and timestamp limits, persists it once and returns `ACKNOWLEDGED`. The originating application must separately prove how this message reached its own user/session.
4. `GET /health`: Local health only, explicitly reports reference mode. No public session, key enrollment, admin grant, merge authority or status-bypass endpoints.

For local verification, run `npm test`. To launch the reference server with Node 22+, configure these environment variables **outside Git** and run `npm run bus:local`:
- `COUNCIL_BUS_DB_PATH`: SQLite file inside a private mode-0700 directory. Database file is chmod 0600.
- `COUNCIL_BUS_INGRESS_PUBLIC_KEY_PEM`: trusted producer's Ed25519 public key.
- `COUNCIL_BUS_ORIGIN_PUBLIC_KEY_PEM`: trusted originating app's **different** Ed25519 public key.
- `COUNCIL_BUS_PRIVATE_KEY_PEM`: Bus's private Ed25519 key, provided by the owning secret manager, not committed.
- `COUNCIL_BUS_ORIGIN_AGENT` and `COUNCIL_BUS_ORIGIN_ROUTE`: exact allowlisted symbolic origin, e.g. `chatgpt` and `founder-relay`.
- Optional `COUNCIL_BUS_PORT` (default 8789). The listener is always `127.0.0.1` and cannot be made public with an env setting.

### Wire contract / signature format

The producer signs the canonical SHA-256 digest from `fingerprint(payloadWithoutSignature)` with Ed25519 and includes a base64 signature; the origin likewise signs each claim/ACK. No bearer shortcut, implicit browser cookie, or origin-chosen webhook URL is permitted. Exact fields are required for the application contracts. Only `reply` is stored as the bounded private payload; the full Council/Court source packets are validated at intake but not persisted. The SQLite journal and DB remain on local protected disk.

Do not use generated testing keys in a deployed service. Never log, publish, or expose trusted private keys or private reply contents. The local reference relies on Node's experimental `node:sqlite` interface. It does not currently implement key rotation, network TLS termination, horizontal scaling, queue expiry/retention policy, cloud durability, configured upstream provider credentials, or actual ChatGPT origin polling. Those are **blocking production gates**.

### Court evidence boundary

`DELIVERY_ATTEMPTED` alone is insufficient. A separate signed origin ACK can be verified against the Bus receipt using the independent `src/deliveryProof.mjs` verifier added in [Council PR #4](https://github.com/jussray/ULTRATHINK-COUNCIL/pull/4). Even signed ACKs only establish trust in the configured keys; they do **not** prove a real model was invoked or that a human saw the answer. Court `HOLD` remains until independently corroborated live runtime, privacy, delivery and provider evidence exists.

### Migration / rollback

This code is supplied as a **stacked PR** on the signed-proof verifier branch. Merge PR #4 first only with its own current-head founder approval; then update this PR against the authorized latest main. No unconditional integration, deployment or physical backing selection is implied. Roll back by dropping this stacked PR and leaving FCR's existing mission/provider runtime unchanged.
