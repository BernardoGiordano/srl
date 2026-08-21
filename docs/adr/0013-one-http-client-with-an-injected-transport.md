# ADR-0013: One HTTP client in the library, with the transport as a parameter

- Status: accepted
- Date: 2026-08-12
- Affects: `source/lib/core/http/client.js`, `source/lib/auth/session-fetch.js`, application services

## Context

Both applications in this repository wrote their own outbound JSON client, about two
hundred lines each, and the copies had already drifted: one grew `put` and `delete`, the
other grew `streamUrl` and an `AbortSignal`, and the 422 field parsing was written twice
with different narrowing. None of that divergence was a decision — an HTTP client is not
where an application says something about itself.

The obvious place for the shared version is `@core/http`. The obstacle is that the
authorized path lives in `@auth/session.js` — the CSRF header, the single shared refresh,
the one retry — and `core/` may not import `auth/`. That is the same dependency rule that
keeps `core/remotes/mfe.js` free of the session, and it is enforced by
`tools/checks/verify-deps.mjs`.

## Decision

`@core/http/client.js` owns the client, and takes the function it sends through as a
parameter. `@auth/session-fetch.js` is the adapter that binds it to the session. A test, a
public API with no session at all, or a remote handed `host.auth.fetch` supplies its own
transport and needs nothing from `auth/`.

Over `fetch` the client adds exactly three things: the base URL, so pointing a deployment
at another API is a manifest edit rather than a search for string concatenation; query
building that drops `undefined` and expands an array into repeated parameters; and one
error type carrying the status and the server's own error code, so a screen can tell "you
may not" from "it broke" and can put a 422 under the input that caused it without parsing
a message.

## Consequences

The seam has two adapters on the day it is drawn, which is the test this repository
applies before pulling anything up into the library.

`AuthSession.json()` remains the shorter path and the right one for an application with
nothing to distinguish. The client reads the response body itself because screens branch
on the code inside it, and that body is gone by the time a thrown `Error` reaches the
caller.

Presentation modules duplicated across the two applications — `app-stat.js`, `format.js`,
`icons.js`, `navigation.js` — are deliberately *not* covered by this decision. Those
diverged on purpose; the HTTP client had not.
