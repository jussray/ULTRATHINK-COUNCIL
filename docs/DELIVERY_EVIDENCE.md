# Council Bus delivery evidence — verification-only boundary

This package validates an **externally produced** delivery receipt plus a separate acknowledgment from the originating AI. This file does not implement the Council Bus. The separate runtime still needs trusted issuer keys, authenticated endpoints, durable deduplication, authorized cross-agent routing, provider invocation, and observable return-to-origin.

## Inputs / evidence classes
- Council/Court and `PREPARED_NOT_SENT` handoff verified using the existing exact-shape validators.
- `delivery` is an Ed25519-signed `juss/council-bus-delivery@v1` packet from the trusted Bus public key. It binds `handoffFingerprint`, `idempotencyKey`, symbolic origin tuple, `DELIVERED` and `deliveredAt`.
- `ack` is an independently signed `juss/council-origin-ack@v1` packet from the trusted origin public key. It binds the same origin and handoff, full signed `deliveryFingerprint`, `ACKNOWLEDGED`, and `acknowledgedAt`.
- Both records are time-limited and checked against an injected trusted clock. Public keys for Bus and origin must differ. The signatures cover the canonical `fingerprint(payload)` bytes (32-byte SHA-256 digest), not the raw JSON representation. Never substitute a string with a `provider:` prefix for a signature or a trusted public key.

## Limits
This is a **stateless** verifier. An old valid pair of receipts could be replayed within the allowed window. The owning runtime MUST persist and deduplicate `handoff.idempotencyKey` and receipt identity, and authenticate the origin session and configured signing public keys out-of-band. The verifier does not establish that a provider independently generated a Council answer or that a human read it. The Court's decision may remain HOLD after delivery.

No private keys, tokens, webhook secrets, user transcripts, trusted callback URLs, or deployments are bundled or created by this export. The bus owner tracked as Linear ENG-7 is a distinct system; its live status is unverified. Source tests generate ephemeral keys as fixtures and are not live delivery evidence.
