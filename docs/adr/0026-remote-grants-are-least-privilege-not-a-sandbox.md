# ADR-0026: Remote grants are least privilege, not a sandbox

- Status: accepted
- Date: 2026-08-12
- Affects: `source/lib/host/remote-host.js`

## Context

A remote runs in the shell's realm, on the shell's origin. Hostile remote code can reach
`document` and patch `fetch`. Nothing in the host contract changes that, and describing
grants as isolation would be a false claim with security consequences.

Real isolation against untrusted code is a cross-origin iframe with `postMessage`, which
costs exactly the shared-DOM benefits this architecture exists to provide: one design
system, one router, one set of element definitions.

Two alternatives to the capability object were considered and rejected. Handing the remote
a token makes every remote reimplement refresh and retry, multiplies the places a
credential can leak, and is unimplementable under the `bff` strategy where JavaScript
never sees a token — a design that only works for the least secure of three storage
strategies is not a design. A global would be readable by every script on the page, grant
the same authority to all of them, and be unrevocable.

## Decision

Each remote receives its own capability object, bounded by its own grants, which the shell
can take back. What crosses the boundary is a function that performs an authorized
request, not the means to authorize one (ADR-0016).

Grants are least privilege against mistakes and scope creep between trusted teams, plus an
audit point. They are documented as that and not as a sandbox.

## Consequences

The API allowlist is defence in depth rather than an enforced boundary: the server cannot
tell which remote made a call, because they all present the same session.

Making it enforceable means the shell exchanging its token for a per-remote,
audience-restricted one (RFC 8693) at a backend-for-frontend. The contract is shaped so
that change is confined to `remote-host.js` — `auth.fetch` is already the only way out,
and no remote holds a credential to re-issue.

Reopen when a remote has to run untrusted code, at which point the answer is the
cross-origin iframe and the loss of shared DOM, not a stricter grant list.
