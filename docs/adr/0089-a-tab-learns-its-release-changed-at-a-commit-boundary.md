# ADR-0089: A tab learns its release changed at a commit boundary

- Status: accepted
- Date: 2026-09-02
- Affects: `source/lib/core/application/release.js`, `source/lib/core/application/types.d.ts`, `source/lib/test/application/release.test.js`

## Context

Every artifact this toolchain builds emits `build.json`: the application's name, the commit
it was built from, the source date. It is cache-classed `revalidate`, `verifyPayload`
requires it by name, `verify-http` proves the origin serves it with the header the report
declares — and nothing has ever read it. `emitReleaseIdentity` wrote a fact with no
consumer.

The cost of that is specific, and it is the workload this library exists for. An internal
tool is left open all day. A deploy lands. The tab keeps running the chunks it booted with,
which is fine right up to the first navigation into a route chunk whose hash-named URL no
longer exists, and the failure the user sees is a route that will not load rather than
"there is a new version".

The generated service worker does not fix it, and deliberately makes it visible instead:
[ADR-0088](0088-the-service-worker-is-generated-from-the-artifact-report.md) does not call
`skipWaiting`, because swapping code under a running tab is the same failure with better
caching. What is missing is not a mechanism but a fact — the tab has no way to know.

Two alternatives were rejected.

**Polling on a timer** was rejected because it asks while the user is reading and answers a
question they can do nothing with. A release the tab learns about mid-screen sits in a
signal until the next navigation anyway.

**Reloading automatically** was rejected outright. A library that reloads the page destroys
unsaved work in whatever form the user is halfway through, and the moment it is safe to do
that is a fact only the application has.

## Decision

**The commit boundary is when to ask.** A navigation is one transaction with exactly one
instant when the DOM changes ([ADR-0002](0002-a-navigation-is-one-transaction.md)), and
`isNavigating` falling back to false is that instant observed from outside the router. It is
also the only instant worth asking at: it is the moment the tab could act on the answer. So
the read rides the navigations the user is already making — an `effect` over the router's
own signal, no router change, no new hook.

**Throttled on the library's one clock.** A minimum interval, default a minute, held by a
flag a `schedule` callback clears rather than by comparing timestamps — `schedule` is the
seam [ADR-0079](0079-one-settled-one-clock.md) installed, and a suite that compared
timestamps would have to sleep past a real minute to see the second read.

**The interface is two signals and a function.** `runningRelease` is what the tab loaded,
`releaseChanged` is whether the origin has moved on, `watchRelease()` starts and stops the
watch. The library decides when the fact is true; the application decides whether a banner
appears, what it says, and whether it offers a reload or takes one at an idle moment.

**A document with no identity is no answer, not "unchanged".** Both halves of
`ArtifactRelease` are null for a build of an uncommitted tree — a legitimate artifact, and
one two builds of which are indistinguishable. Such a document is refused, as is anything
that is not the shape `emitReleaseIdentity` writes: a misconfigured origin's index page
reaches the same conclusion by the same rule. The name is part of the identity, because a
different application at this origin is not a new release of this one.

**Once the answer is yes it stays yes, and the watch stops.** Code cannot get less stale by
being asked again, and an application that dismissed its banner has not changed which chunks
the tab is running.

## Consequences

**A new module in `core/application` imports `core/navigation`.** Within `core/` that is
allowed and `npm run verify` says so, but it is the first time the startup layer has
depended on the router. The alternative — the router calling into a release module — points
the dependency at the thing with more reasons to change, and would put a fact about
deployment inside the navigation transaction.

**One request per navigation at most, and one per minute in practice.** It is a conditional
GET against a file served `private, no-cache`, so the common answer is a 304 with no body.

**Startup is still seven steps.** `watchRelease()` is a call an application makes, for the
reason `registerServiceWorker()` is: a development origin serves a `build.json` written by
`deploy.local.sh` in an older shape, and the right behaviour there is to read no identity
rather than to fail a boot.

**The example application does not call it, and the reason is the benchmark.** A read at
every commit boundary is a request inside the window `delivery/lazy-*` measures, and those
workloads gate on request counts. Wiring the reference application means changing what the
benchmark declares first.

**What would reopen this.** An application that needs to know before the user navigates —
a dashboard left open on one screen for hours is the case the commit boundary does not
serve, because it never reaches one. The answer there is a second trigger, not a different
mechanism: the signals and the comparison would not move.
