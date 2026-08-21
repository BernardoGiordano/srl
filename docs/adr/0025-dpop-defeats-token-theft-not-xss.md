# ADR-0025: DPoP is adopted to defeat token theft, and does not close XSS

- Status: accepted
- Date: 2026-08-12
- Affects: `example/src/auth/dpop-store.js`

## Context

DPoP (RFC 9449) binds a token to a key the client holds. The private key is generated
`extractable: false` and stored as a live `CryptoKey` in IndexedDB — the only browser
storage that can hold one without serialising it — and `crypto.subtle.exportKey()` on it
rejects. An attacker with script execution on the origin cannot steal the key.

They do not need to. They can call `crypto.subtle.sign()` with the same key handle and
have the browser mint valid proofs on demand, for as long as they hold the page. That is
the signing-oracle attack. "The key is non-extractable" is therefore not the same claim as
"this is XSS-safe", RFC 9449 is silent on browser key storage, and no configuration of the
store fixes it.

## Decision

`dpop` is offered as a strategy, and its own module header states the limit before the
first line of implementation, so it cannot be chosen on the strength of the acronym.

What it genuinely buys, and it is worth having:

- A token captured in transit, from a log, or from a compromised downstream service is
  useless without the key. Bearer tokens are not.
- Proofs are bound to one method and one URI, so a captured proof cannot be replayed
  against a different endpoint.
- Exfiltration to an attacker's own infrastructure is impossible: the attack has to run
  inside the page, which narrows the window to the session and leaves it detectable.

## Consequences

Use `dpop` to defeat token theft, alongside a strict CSP, Subresource Integrity and
Trusted Types, and knowing that XSS on this origin remains exploitable. If XSS is the
threat that actually has to be closed, the answer is the `bff` strategy (ADR-0021), not a
better DPoP configuration.

This record exists mainly to be cited in the argument it keeps losing: a reviewer who
reads "non-extractable key" and concludes the token layer is XSS-safe is making a mistake
this repository has already made once.
