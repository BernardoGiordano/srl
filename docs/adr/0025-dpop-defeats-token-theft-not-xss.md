# ADR-0025: DPoP defeats token theft and leaves XSS open

- Status: accepted
- Date: 2026-08-12
- Affects: `example/src/auth/dpop-store.js`

## Context

DPoP (RFC 9449) binds a token to a key the client holds. The example generates the private key with `extractable: false` and stores the `CryptoKey` in IndexedDB, so `exportKey()` rejects and script on the page can't steal the key.

Script on the page doesn't need to steal it. It can call `crypto.subtle.sign()` with the same key handle and mint valid proofs for as long as it runs. A non-extractable key is therefore no defense against XSS, and no store configuration changes that.

## Decision

`dpop` is offered as a strategy, and its module header states this limit before any code.

DPoP still buys three things.

- A token captured in transit, in a log or from a downstream service is useless without the key.
- A proof is bound to one method and one URI, so it can't be replayed against another endpoint.
- The credential can't be taken off the page, so an attack has to run inside the live session.

## Consequences

Use `dpop` against token theft, together with a strict CSP, Subresource Integrity and Trusted Types, and assume XSS on the origin is still exploitable. If XSS is the threat to close, use `bff` (ADR-0021).
