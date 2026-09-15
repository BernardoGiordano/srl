# ADR-0013: One HTTP client with an injected transport

- Status: accepted
- Date: 2026-09-09
- Affects: `source/lib/core/http/client.js`, `source/lib/auth/session-fetch.js`

## Context

Both applications in this repository once carried their own JSON client, and the copies had drifted. One had `put` and `delete`, the other had streaming and abort signals, and each parsed 422 field errors differently.

The shared client belongs in `@core/http`. The authorized request path lives in `@auth/session.js`, and `core/` may not import `auth/`.

Separately, two screens fetched the same record at the same moment. A layout and its tab both read `order(id)` on mount, and the router gives a child level no way to receive data from its parent.

## Decision

`@core/http/client.js` owns the client and takes the transport as a parameter. `@auth/session-fetch.js` binds it to the session. Tests, public APIs and remotes (through `host.auth.fetch`) pass their own transport.

The client adds three things to `fetch`:

- a base URL, so pointing at another API is a manifest edit
- query building that drops `undefined` and repeats array values
- one error type carrying the status and the server's error code

`ApiClient.get` joins a request already in flight for the same URL instead of sending a second one. The shared entry lives from send to settle and stores nothing afterwards. Each caller gets its own copy of the body, and each caller's `signal` cancels only that caller. The request aborts when the last caller leaves. Only `get` is shared, because two identical POSTs are two intentions.

## Consequences

- The seam had two adapters on the day it was drawn, which is the bar for moving code into the library.
- A screen can tell "forbidden" from "broken" and put a 422 under the right input without parsing a message.
- A detail screen with a tab costs one request for its record.
- Sharing a settled record across screens is a store or route-scoped injection, and neither belongs in the client.
