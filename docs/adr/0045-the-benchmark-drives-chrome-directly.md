# ADR-0045: The benchmark drives Chrome directly and blocks the network without disabling the cache

- Status: accepted
- Date: 2026-08-12
- Affects: `tools/benchmark/browser.mjs`, `tools/benchmark/browser/support.js`

## Context

`@web/test-runner` already runs browser code over the right origin, so reusing it for
benchmarks is the obvious move. It is the right tool for asserting behaviour and the wrong
one for measuring it: it owns the sample loop, decides when a page is recycled, and gives a
suite no way to collect garbage or read a heap. A benchmark needs exactly those three.

Guaranteeing that no off-origin request is served has an equally obvious answer,
`setRequestInterception`, and it is also wrong here: interception disables Chrome's cache,
and a warm start measured with no cache is not a warm start.

## Decision

The harness drives Chrome directly over the DevTools protocol. Both halves — tests and
benchmarks — still run the same source over one origin, which is the property that matters.

The network is blocked at the network stack rather than by interception, with two flags
that leave caching untouched: `--host-resolver-rules`, so every host but the loopback
fails to resolve, and `--proxy-server`, so anything that got past that has nowhere to go. A
workload reaching for a CDN fails rather than quietly measuring somebody's edge cache, and
the failure names the URL instead of timing out.

The sample loop runs inside the page. A round trip over the protocol per sample is tens of
milliseconds of measurement noise attached to workloads whose whole cost is sometimes one
millisecond.

## Consequences

Garbage collection, heap reads, DOM node counts and retained listener counts become
available, and those are what the memory and lifecycle workloads are built from. None is
reachable from inside a page: `performance.memory` is coarse, quantised and clamped, and
there is no counter for retained listeners at all.

Every sample gets a fresh scope whose Lit root is explicitly cleared, because clearing the
root is what releases the signal effects a standalone `render()` owns. Without it each
sample is measured against a slightly larger program than the last.

Correctness is enforced twice — per sample in the page, and again in Node, where
aggregation refuses a workload with any failed sample. Fast and wrong is not a result.
