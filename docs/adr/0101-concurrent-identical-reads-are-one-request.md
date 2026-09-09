# ADR-0101: Concurrent identical reads are one request

- Status: accepted
- Date: 2026-09-09
- Affects: `source/lib/core/http/client.js`, `source/lib/test/http/client.test.js`, `example/test/app.smoke.test.js`

## Context

Two detail screens in `example/` fetched the same record twice on every navigation to them.
`OrderDetailPage` reads `SALES_SERVICE.order(id)` for its header, and `OrderSummaryTab` —
the index tab the layout renders inside itself — reads the same call for its customer
block. `EmployeeDetailPage` and `EmployeeProfileTab` are the same pair one route over. Both
requests leave at mount, for the same URL, and both are answered.

Neither component is written wrongly. A tab cannot read what its layout loaded: the router
builds a child level with `createElement` and hands it no data
([ADR-0004](0004-routes-are-flattened-at-configuration-time.md)), and the injector has one
root scope, so nothing can own a value for the lifetime of the section the user is in.
Sharing has no seam, and re-fetching is the only thing left — which is what the tab's own
comment says it is doing.

[ADR-0076](0076-an-asynchronous-read-is-a-resource.md) refused a cache inside `resource()`,
and that still holds: keying, staleness and revalidation are decisions about an
application's data, and an application makes them. But the duplicate here needs none of
those decisions. The second request is sent while the first is still open, for a URL that
is character-for-character the first, and the answer is one answer.

## Decision

**`ApiClient.get` joins a read already in flight for the same URL** rather than sending a
second. `SharedRead` in `core/http/client.js` holds the request and everybody waiting on
it, keyed by the built URL, in a map that belongs to the client instance — two clients with
two transports share nothing.

**The entry lives from the send to the settle and no longer.** A `get` that starts after
the previous one finished is a new request and reads whatever the server says now. That is
what keeps this out of ADR-0076's territory: there is no stored response, no key with a
lifetime, and nothing to invalidate.

**Every caller gets its own copy of the body.** The first is handed the parsed value and
the rest a `structuredClone` of it, so two screens that both mutate what they were given
cannot see each other's edits — exactly as when each had its own response to parse.
Coalescing changes the request count and nothing a caller can observe.

**Cancellation stays per caller.** A caller's `signal` rejects that caller alone, with the
reason `fetch` would have rejected it with. The request is aborted only when the *last*
caller leaves, and the entry is dropped before that abort, so a `get` arriving in between
starts a fresh request instead of joining one on its way to rejecting.

**Only `get`.** Two identical POSTs are two intentions, and a client that coalesced them
would decide that one of them did not happen.

**Rejected: dedup in the services.** `SALES_SERVICE.order` could hold its own in-flight
map. Every service that a layout and a tab share would need one, each written slightly
differently, which is the drift [ADR-0013](0013-one-http-client-with-an-injected-transport.md)
pulled the client up to end.

**Rejected: route-scoped injection, for now.** A section-scoped provider would let the
layout own the record and the tab read it, removing the second request rather than
coalescing it — and it would share the settled *value*, which this does not. It is a larger
change to the injector and the route configuration, and it remains a
[stated non-goal](../position-and-non-goals.md) with a trigger of its own. One round trip
was the whole cost here, and this is the part of it that needed no new interface.

**Rejected: keying on more than the URL.** A `get` carries no body and no caller headers —
`Accept` is constant and the transport adds credentials itself — so the URL is the request.
Two callers that build the same query with the keys in a different order produce different
URLs and send two requests; that is a missed share, not a wrong answer.

## Consequences

An order or employee detail screen costs one request for its record instead of two, proved
end to end: `example/test/app.smoke.test.js` navigates to a detail route and asserts one
`GET /api/orders/OR-00002` across the layout and the tab.

`get` no longer passes the caller's `AbortSignal` to the transport, because the request is
not the caller's any more. The suite asserts what replaced it — one caller leaving does not
cancel what the others wait for, the last one leaving aborts the request, and a failure
reaches every caller.

The listener rule `resource()` follows now has a second holder: `SharedRead` drops the abort
listener it put on a caller's signal on every terminal path, and
`instrumentedAbort` moved into `source/lib/test/harness.js` so both suites assert it the
same way.

**What would reopen it:** two screens that need the same *settled* record rather than the
same request — a header and a tab that must not disagree after a save. That is shared state
with a lifetime, which is route-scoped injection or a store, and neither is this record.
