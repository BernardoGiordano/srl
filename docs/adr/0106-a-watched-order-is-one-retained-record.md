# ADR-0106: A watched order is one retained record

- Status: accepted
- Date: 2026-09-10
- Affects: `example/src/state/order-records.js`, `example/src/pages/sales/order-detail-page.js`, `example/src/pages/sales/order-summary-tab.js`, `example/src/main.js`, `example/test/order-records.test.js`, `example/test/app.smoke.test.js`

## Context

The order detail layout and its summary tab both read one order. They are separate route
levels, and the router mounts a child without a props channel from its parent, so each
previously owned a `resource()` and called `SalesService.order(id)` itself.

[ADR-0013](0013-one-http-client-with-an-injected-transport.md) made the concurrent pair one
HTTP request. It deliberately retained no response after that request settled. The two
resources therefore still held independent values, failure flags, refresh decisions and
lifetimes. A status write refreshed the layout's copy only. The summary kept the customer
projection from its earlier order response. Status does not change that projection today,
but any mutable field added there would have exposed the split refresh immediately.

This is the reopening trigger ADR-0013 named: two screens need the same settled record,
not merely the same request. It is also the keyed-result trigger
[ADR-0076](0076-an-asynchronous-read-is-a-resource.md) named, but it does not establish a
general query-cache policy. The application knows that an order id is the identity, that a
status write invalidates that record, and that no reader means there is no reason to retain
it. The framework does not.

## Decision

**`OrderRecords` is the application-owned shared-state module.** Its interface is one
operation:

```js
const order = inject(ORDER_RECORDS).watch(
  () => routeParams.value.id ?? '',
  this.lifetime,
);
```

The returned `OrderRecord` has the familiar `value`, `pending`, `failed` and `reload`
members, plus the domain operation `setStatus(status)`. Both the layout and the tab cross
this interface. Neither coordinates a key change, an initial load, another reader, or a
release.

**One id has one `resource()` while at least one watcher retains it.** The first watcher
creates the entry and starts its read. Another watcher of the same id receives signals over
that same resource and starts nothing. The entry has its own `AbortController`, independent
of either component lifetime, so one route level leaving does not abort work another still
needs.

**The watched id is reactive.** The router reuses the complete route chain for
`/orders/OR-1` to `/orders/OR-2`. `watch()` follows the caller's id function, releases the
old keyed entry and retains the new one in the same signal update. That ordering and the
old-value cleanup no longer appear in either route level.

**A status write and its refresh are one module operation.** `setStatus` writes through the
sales transport adapter and then reloads the retained resource once. Every watcher receives
the settled result. A rejected write still reaches the screen, which owns the localized
error message; a failed refresh still reaches every reader through `failed`.

**The final release deletes immediately.** A component lifetime ending stops its id watcher
and releases its lease. The last lease deletes the map entry before aborting its resource
lifetime. A later visit therefore reads the server again. There is no TTL, stale flag,
background revalidation, capacity policy or settled record after the last reader.

**Rejected: route-scoped injection.** A route-owned provider could give the parent and child
one value, but it would change the injector and router interfaces to solve a lifetime this
application can already state exactly. The record can also follow a parameter change on a
reused route without remounting a scope. Route scope remains justified only when a service
itself must live for a section.

**Rejected: a generic query cache or keyed resource in core.** The only proven key, write
invalidation rule and lifetime belong to orders. A generic module would either expose those
policy choices to every caller or silently choose them. If a second domain repeats this
whole interface, the common implementation can be extracted with two real consumers rather
than designed from one.

**Rejected: keeping one resource in the layout and passing it down.** The router intentionally
has no parent-to-child props channel. Adding one for this record would make route mounting
carry application data and would still leave a non-child reader without an owner.

## Consequences

Changing an order id starts one shared read and replaces both route levels' settled value.
Changing tabs releases the summary watcher while the layout retains the record; returning to
the tab starts no read. A status write performs one refresh and both readers observe it.
Leaving the detail route releases the final watcher, and revisiting starts a fresh read.

`example/test/order-records.test.js` proves those transitions through the module interface,
including aborting an in-flight read only after the final release.
`example/test/app.smoke.test.js` proves the same ownership through the real router, injector,
components and HTTP adapter, including a status write.

`ApiClient.get` still coalesces overlapping reads from unrelated resources. `resource()`
stays one unkeyed asynchronous value with latest-call-wins semantics. Neither module gains a
settled cache.

**What would reopen it:** a second application domain repeating keyed retain, reactive key
changes, shared refresh and final release would justify extracting a generic module beneath
the two domain interfaces. A service whose lifetime must equal a route section, independent
of any watched record, would reopen route-scoped injection.
