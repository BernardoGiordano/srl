# ADR-0023: A token response is rebuilt field by field, or refused

- Status: accepted
- Date: 2026-08-12
- Affects: `source/lib/auth/session-policy.js`

## Context

The three token stores each spoke to a token endpoint and each cast the successful body
straight into a `Session`. A 200 carrying `{}` therefore produced a session whose subject,
name, expiry and access token were all `undefined`: `isAuthenticated` went true, guards
let the user through, and the next request sent `Authorization: Bearer undefined`.

A correct server still refuses that request, so this was never a server bypass. It was the
client believing something the server never said, which is a state no screen can recover
from because nothing in it is true.

Validating the payload in place would have caught the empty body. It would also have left
the original object in play afterwards — and the original object is the one an
attacker-shaped response controls, including its prototype and any field the checks did
not name.

## Decision

`session-policy.js` is the one place an untrusted authentication payload becomes session
state. The payload is rebuilt there, field by field, or refused. Rebuilt rather than
checked, for the same reason `remotes/manifest-policy.js` rebuilds a manifest (ADR-0010).

What belongs here: payload shape, error classification (ADR-0024) and normalization. What
does not: performing the exchange, which is the stores', and deciding what a failure does
to session state, which is `session.js`'s.

## Consequences

Every store gets the same admission, so a fourth strategy inherits it rather than
re-deriving it.

An admission failure is terminal on purpose. A token endpoint answering 200 with a body
this module cannot read is misconfigured or hostile, and neither gets better on the third
attempt.
