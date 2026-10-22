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


## Signed producer and origin client adapters

The separate `bus/client.mjs` exposes **two capability-separated factories**: `createLocalCouncilBusProducer({url,origin,ingressPrivateKey,...})` and `createLocalCouncilBusOrigin({url,origin,originPrivateKey,busPublicKey,...})`. The receiver rejects configurations containing a producer signing key, and vice versa. Producers must not hold origin signing keys; origin processes must not hold ingress signing keys. Its `submit` function signs a complete Council/Court/handoff plus bounded message, using the authorized producer key. `receiveAndAcknowledge(onMessage)` signs a fresh origin claim, verifies the independent Bus signature and exact handoff tuple, and returns the message to the owning application. It sends a signed origin ACK **only after** `onMessage` returns exactly `true`. A handler failure/false leaves the delivery unacknowledged for another attempt. This is an app-integration seam, not evidence that ChatGPT itself can receive background messages or persist/see them. The adapter restricts transport to loopback HTTP to avoid insecure automatic remote routing; production requires separately authorized TLS, key management and origin identity binding. Tests demonstrate this with ephemeral keys and an actual loopback HTTP service.

## Authenticated message-body integrity and bounded client transport

A signed delivery receipt alone authenticates routing metadata, **not the answer body**. The Bus now emits a separate Ed25519-signed `juss/council-bus-content@v1` record binding the SHA-256 UTF-8 digest of the actual stored answer to the immutable signed delivery receipt fingerprint, exact handoff and origin tuple. The receiving client validates both signatures and the *received* plaintext hash before calling `onMessage` or signing an ACK. A substituted, missing, or forged content record fails closed; regression tests alter the returned HTTP JSON while retaining the genuine Bus receipt. The `deliveryProof.mjs` verifier in separate PR #4 still verifies the independent routing receipt plus origin ACK; the additional content record must be verified by the recipient to claim answer integrity.

The origin client caps response bodies at 64 KiB and uses a configurable 100–30000 ms HTTP deadline (default 5000 ms) with `AbortSignal`. The injected HTTP transport must honor the signal for cancellation; an adapter that ignores it can continue in the background. Signed content integrity is *not* evidence of an actual provider call, permission to merge, or proof that ChatGPT can display this message.

## Expired delivery recovery

The origin rejects delivery receipts older than the configured five-minute freshness window. A persisted but unacknowledged message therefore **must not** retain the first receipt forever. On a fresh signed origin claim more than five minutes after the previous delivery, the local Bus atomically replaces that stale receipt with a new Bus-signed delivery/content pair while keeping the same queued message and handoff. An old in-flight ACK is deliberately invalidated by the refreshed delivery fingerprint; the originating app must handle retries idempotently and sign an ACK for the latest receipt. This does not make delivery exactly-once, or establish visibility to a ChatGPT conversation. Regression tests cover SQLite restart, stale receipt replacement, content binding and valid new ACK.


### Credential membrane and hard deadlines

An application must instantiate producer and origin adapters in **different, permission-scoped processes or deployment identities**, not merely create both in one Node process. The producer can only submit; the origin can only poll and acknowledge. Old combined-client factory has been removed from this unmerged review branch because exposing both private keys to the originating agent violated the intended separation. Constructors fail closed on opposite-role and unknown option fields. Every fetch/response operation has a hard local Promise deadline in addition to AbortSignal (100–30000 ms); a custom HTTP adapter that ignores abort may continue doing work after the caller returns, so owning runtime cost and connection controls remain mandatory. These changes do not establish a deployed Bus or genuine live ChatGPT origin integration.
