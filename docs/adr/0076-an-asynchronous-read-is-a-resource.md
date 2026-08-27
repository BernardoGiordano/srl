# ADR-0076: A screen's asynchronous read is a resource, and the latest call wins

- Status: accepted
- Date: 2026-08-27
- Affects: `source/lib/core/foundation/resource.js`, `example/src/pages/`

## Context

The most repeated thing an application author writes on this library was an asynchronous
read, and it had no primitive. Twenty screens in `example/` wrote the same block:

```js
async load() {
  this.#request?.abort();
  const request = new AbortController();
  this.#request = request;
  this.failed.value = false;
  try {
    const result = await inject(SERVICE).rows(request.signal);
    if (request.signal.aborted) return;
    this.rows.value = result.rows;
  } catch {
    if (!request.signal.aborted) this.failed.value = true;
  } finally {
    if (this.#request === request) this.#request = undefined;
  }
}
```

Forty `abort()` calls across twenty files, twenty `failed = signal(false)` declarations,
twenty `onDestroy` bodies whose whole content was aborting that controller. Four states —
idle, pending, settled, superseded — hand-rolled per screen, and the copies had already
drifted: some cleared `failed` before the request and some after, some tracked "has ever
loaded" with a second `loaded` boolean and some inferred it from an empty array, two
screens blanked the record on failure and the rest kept it. Every one of those differences
is a rendering difference somebody would eventually report as a bug on one screen and not
the other.

The measurement that justified `@core/forms` is the same one, with a smaller sample: a
nine-field screen written twice at 21 lines per field. This is twenty screens, already
written.

**The rejected alternative is an auto-tracking resource**, which is what Angular's
`resource()` is: a loader whose signal reads become its inputs, re-running when one
changes. It is the wrong fit for the screens here. `ui-table` emits one `query-change`
carrying a page, page size, sort and filter set together; a resource tracking four signals
fires four requests and aborts three, and the intent — "this is one question" — is
expressed by nothing. Worse, the tracking is invisible: a loader that later reads one more
signal silently acquires a trigger. Reloading is an event, and an event has a call site.

**Also rejected: a query cache.** Keying, deduplication and stale-while-revalidate are a
store, and a store is a decision an application makes about its own data. This is the
primitive underneath one, and a library that shipped the store would be answering a
question nobody in this repository has asked yet.

## Decision

`resource(load, { initial, lifetime })` in `@core/foundation/resource.js`, returning
`{ value, pending, failed, reload }` — three signals a template already knows how to bind,
and one method.

**The latest call wins.** `reload()` aborts the request in flight, and a response arriving
for an aborted request is dropped rather than written. The superseding request owns
`pending` from that moment, so a stale response cannot clear a spinner that belongs to a
newer one.

**`initial` is required.** A screen binds `value` from its first render, and an interface
whose value is `T | undefined` makes every template carry the empty case twice. `pending`
starts true for the same reason: `onMount` runs after the first paint, so a flag that
started false would render an empty state for one frame before the request it is about to
make — and a screen that loads conditionally, waiting on a route parameter, is showing
exactly what it was showing before.

**The loader runs untracked.** Reading a signal inside it — `this.#query`,
`routeParams.value.id` — is how a request finds its inputs, and none of those reads may
become a dependency of the `effect` that called `reload()`. Detail screens reload from an
effect over `routeParams`; without this, one of them would eventually subscribe itself to
a signal its own request writes.

**`lifetime` may be a function**, and in a component it is `() => this.lifetime`.
`SignalElement` aborts its controller on disconnect and builds a new one on the next read,
so a resource that captured the signal in a field initialiser would hold an aborted one
for the rest of the element's life and every reload after a DOM move would abort before it
was sent.

**`reload()` resolves with the value**, or `undefined` when the request was superseded,
aborted or rejected. Two screens need that: the customer form applies a settled record to
a `group()` rather than binding it, and the infinite-scroll products screen appends each
window to rows it accumulates itself.

## Consequences

Twenty screens lost their controller field, their abort-on-destroy, their `failed` signal
and their staleness check. Six of them lost their `onDestroy` entirely. What is left in a
list screen is the request and the shape of the answer.

Staleness lives in one module with a suite, which is what the twenty copies could not
have. `source/lib/test/foundation/resource.test.js` asserts the race directly — two
reloads, the stale response resolving *last* — and that assertion is worth more than
twenty screens that each look correct.

Two behaviours changed on purpose. `pending` is now "a request is in flight" rather than
"nothing has arrived yet", so a retry shows the loading state again over rows that are
still on screen. And a failed reload keeps the value it had, which is right for a list
being refreshed and wrong for a detail header — the two detail screens spell that out with
a `record` getter that reads `null` while `failed`, rather than the resource guessing which
kind of screen it is on.

Two write paths re-read instead of patching the list they had. The account administration
screen and the order header both used to merge the server's response into their own copy of
the record; the rows belong to the resource now, and re-reading is one request against a
screen holding a dozen of them. A screen where that trade is wrong keeps its own signal and
folds `reload()`'s return value into it, which is what the products screen does.

**The collection's own asynchronous paths are deliberately not converted.**
`ui-dynamic-filter` runs N rule loads in parallel and merges them into a `Map` keyed by
ref, and its typeahead search is debounced across several rules at once; neither is one
value with one latest call, and forcing them through this interface would mean passing a
`Map` as the value and losing what the per-rule generation counter is actually guarding.
`ui-combobox`'s `#pendingCodes` and `ui-table`'s `#lastInfiniteRequest` are not requests at
all — one is a set of codes awaiting options, the other a dedupe key for an event.

**What would reopen it:** a second consumer that needs several keyed results from one
declaration. That is a keyed resource, not a parameter on this one, and
`ui-dynamic-filter` is the existing candidate for it. Adding `key` to this interface, or a
`stale` flag, or a cache, means this record was too small — but each of those is a
different module, and this one stays the thing they would be built out of.
