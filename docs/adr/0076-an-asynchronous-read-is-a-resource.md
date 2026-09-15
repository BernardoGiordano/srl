# ADR-0076: An asynchronous read is a resource, and the latest call wins

- Status: accepted
- Date: 2026-08-27
- Affects: `source/lib/core/foundation/resource.js`, `example/src/pages/`

## Context

Twenty screens in `example/` hand-wrote the same asynchronous read, with an `AbortController` field, a `failed` signal, a staleness check and an abort in `onDestroy`. The copies had drifted. Some cleared `failed` before the request and some after, and some kept the old record on failure while others blanked it.

An auto-tracking resource, like Angular's `resource()`, re-runs whenever a signal it reads changes. That fits badly here. `ui-table` emits one `query-change` that carries page, size, sort and filters together, and a tracking resource would fire four requests and abort three. Tracking is also invisible, so a loader that reads one more signal quietly gains a trigger.

A query cache, with keys, deduplication and stale-while-revalidate, is a store, and a store is an application's decision.

## Decision

`resource(load, { initial, lifetime })` returns `{ value, pending, failed, reload }`.

- The latest call wins. `reload()` aborts the request in flight and drops any response that arrives for an aborted request.
- `initial` is required, so a template never handles `undefined`. `pending` starts `true`.
- The loader runs untracked, so signals it reads don't become dependencies of the effect that called `reload()`.
- `lifetime` may be a function. In a component it is `() => this.lifetime`, which picks up a fresh controller after the element moves in the DOM.
- `reload()` resolves with the value, or with `undefined` when the request was superseded, aborted or failed.

## Consequences

- Staleness lives in one module, with a test for the race.
- `pending` means a request is in flight, so a retry shows the loading state over rows still on screen.
- A failed reload keeps the previous value. A screen that must hide stale data does so itself.
- The collection's own asynchronous paths, such as `ui-dynamic-filter`'s parallel rule loads, aren't single values and don't use this.
- A consumer that needs several keyed results from one declaration would need a separate keyed resource.
