# ADR-0026: Remote grants are least privilege and no sandbox

- Status: accepted
- Date: 2026-08-12
- Affects: `source/lib/host/remote-host.js`

## Context

A remote runs in the shell's realm on the shell's origin. Hostile remote code can reach `document` and patch `fetch`, and nothing in the host contract prevents it. Describing grants as isolation would be a false security claim.

Real isolation is a cross-origin iframe with `postMessage`. It gives up the shared DOM, design system, router and element definitions this architecture exists to provide.

Two other designs were rejected. Handing each remote a token multiplies refresh logic and leak points, and can't work under `bff`, where JavaScript never sees a token. A global object would be readable by every script, grant them all the same authority and be impossible to revoke.

## Decision

Each remote gets its own capability object, bounded by its own grants, which the shell can revoke. What crosses the boundary is a function that performs an authorized request (ADR-0016).

Grants guard against mistakes and scope creep between trusted teams, and they give an audit point. The documentation describes them that way.

## Consequences

- The API allowlist is defense in depth. The server can't tell which remote made a call, because every remote presents the same session.
- Enforcing grants on the server would mean exchanging the shell's token for a per-remote, audience-restricted one (RFC 8693) at a backend. That change stays inside `remote-host.js`.
- A remote that must run untrusted code belongs in a cross-origin iframe.
