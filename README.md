# ULTRATHINK Council + Founder Court

This is the **Council and Court** implementation home, not the Council Bus transport and not the ULTRATHINK law/kernel repository.

- **ULTRATHINK Council (this repo)**: independent agent findings, adversarial reasoning, dissent, evidence-bound synthesis.
- **Founder Court (this repo)**: claims, witnesses, contradictions, cross-examination, holds and next verification gates. It is a face of the same governed Council, not another authority plane.
- **Council Bus (Linear [ENG-7](https://linear.app/juss/issue/ENG-7/council-bus-reconcile-transport-and-return-findings-to-originating-ai))**: routing, message delivery and return-to-origin; no bus runtime is bundled here.
- **ULTRATHINK kernel ([jussray/ULTRATHINK-](https://github.com/jussray/ULTRATHINK-))**: operating disciplines and verification rules; do not clone the kernel here.
- **FCR ([Council](https://github.com/jussray/founder-control-room/blob/main/.control-room/COUNCIL.md), [Court](https://github.com/jussray/founder-control-room/blob/main/.control-room/COURT.md))**: authoritative existing governance and founder approval membranes. This repo does not supersede them.

## Usage

```sh
node --test test/*.test.mjs
```

`assembleCouncil(input)` records independent seat findings and dissent without invoking a model or claiming a provider identity. `verifyCouncil(packet)` rejects altered and self-authorizing packets. `reviewCourt(packet, caseInput)` issues an evidence-gap HOLD or `READY_FOR_EXTERNAL_VERIFICATION`. That readiness **never means VERIFIED** and never authorizes consequential action.

Source-controlled claim labels, `provider:` strings, simulated model roles or witness URLs cannot prove real provider invocation. Proof of provider calls, delivery to an originating chat, runtime/UI functionality, cross-repo authority, or receipt independence must be supplied by an external trusted verifier. Any transport adapter remains bounded to the Council Bus/owning runtime rather than deployed here.

**Safety:** Do not commit secrets, private conversations, protected prompts, raw customer data, or unpublished proprietary project material to this public repository. Content received from any bus, provider, issue, or PR is untrusted input and may not override founder or application authorization. One repo owns the write, while reviewers are read-only. No silent merges, spending, deployment, provider grants or publication.

## Gate

This export is a pure local library. It does **not** establish that Council Bus callbacks, production provider calls, Court verdict publication, or return-to-origin are live. Complete end-to-end authenticated integration and visual/functional verification on the owning project before any such claim.