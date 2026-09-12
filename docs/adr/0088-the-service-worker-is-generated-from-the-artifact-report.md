# ADR-0088: The service worker is generated from the artifact report

- Status: accepted
- Date: 2026-09-02
- Affects: `cli/delivery/service-worker.mjs`, `cli/delivery/build.mjs`, `cli/delivery/artifact-report.mjs`, `source/lib/core/application/worker.js`, `cli/test/service-worker.test.mjs`

## Context

`cacheClass()` in `cli/delivery/build.mjs` decides `immutable` or `revalidate` for every
file a build emits, `verifyPayload` refuses a build that leaves one `unknown`, and
`artifact.json` carries the answer — a class and a sha256 per file — to three readers:
`verify-http` proves the origin serves each class with the header the report names,
`release` copies them, and the benchmark writes budgets against the totals
([ADR-0074](0074-the-artifact-report-is-a-named-shape.md)).

None of those readers is a browser. A policy this repository states once, enforces at build
time and verifies over HTTP stops at the network boundary, and the client it is about is
told none of it. A second load re-asks for files whose URLs are a hash of their own bytes,
and a login-gated internal tool on a flaky connection has no shell at all.

The usual way to close that is a bundler plugin that globs the output directory and writes
its own precache manifest. That was rejected, and it is the specific thing this repository
is arranged to avoid: it is a second derivation of a fact already derived, admitted and
validated here, and the two drift the first time a naming rule moves on one side. It is the
same argument [ADR-0074](0074-the-artifact-report-is-a-named-shape.md) made against six
hand-rolled validations of one shape.

**A web app manifest was also rejected, and not on the same grounds.** Icons, `display`,
`theme_color` are not a module and not derived from anything — they are scaffold data, so
they belong in the files `srl new` writes ([ADR-0073](0073-the-application-shape-is-a-module.md)).
A generator for them would concentrate nothing.

## Decision

**One module, whose whole input is facts the report carries.** `serviceWorkerSource(facts)`
is pure — report subset in, JavaScript out — so a precache list is asserted from a literal
without running Vite over an application, which is what
[ADR-0080](0080-the-entry-document-names-the-graph.md) established for the document half of
the same question.

**The precache is the entry closure, and nothing beyond it.** The document, the module
closure the entry document already names in a `modulepreload`, and the markup those modules
define — `templateGroups.entry` ([ADR-0086](0086-the-manifest-groups-templates-by-chunk.md)).
That is exactly the set a cold start transfers before its first paint, so an install stores
what the browser fetched anyway rather than adding requests to a first load. Route chunks
and locale bundles are cached on first use instead, which is the difference between an
install that costs one screen and one that costs the application.

**The closure has one definition.** `entryClosure` moves to `cli/delivery/artifact-report.mjs`,
beside `entryChain`. Three consumers now state the same rule — `entryHints` names those
chunks in the document, `groupTemplates` calls their templates the `entry` group, the worker
precaches them — and a fourth definition of "what the first paint costs" would be a fourth
chance for them to disagree.

**The fetch handler answers for two shapes and returns for everything else.** Hash-named
`/assets/` is cache-first; the four fixed URLs — the document, `app.manifest.json`,
`build.json`, `i18n/*.json` — are network-first with the cache as the offline fallback; a
navigation is answered by the shell whatever path it names, because the router owns every
path on this origin. Everything else reaches the network untouched.

**A Remote is in "everything else", by construction.** A Remote publishes under
`/remotes/<name>/<version>/`, on its own cadence, and its bytes belong to whoever deployed
it ([ADR-0016](0016-a-remote-reaches-the-shell-only-through-its-host-context.md),
[ADR-0017](0017-remotes-share-dependencies-by-url-identity.md),
[ADR-0026](0026-remote-grants-are-least-privilege-not-a-sandbox.md)). The immutable rule is anchored at
`/assets/` precisely so a Remote's own assets do not match it.

**Activation retires the caches this Application named, and leaves the rest of the origin
alone.** A cache name is `srl:<app>:<digest>`, so the prefix says who wrote it, and the
activate handler deletes the names under its own prefix rather than every name that is not
the current one. An origin is shared: a second Application can be deployed beside this one,
a Remote can cache its own bytes, and a page can open a cache the framework knows nothing
about. Deleting those is the same mistake as caching a Remote's bytes, in the other
direction — data this artifact did not write is not this worker's to destroy
([ADR-0016](0016-a-remote-reaches-the-shell-only-through-its-host-context.md),
[ADR-0026](0026-remote-grants-are-least-privilege-not-a-sandbox.md)). The rule lives in the
handler that acts on it, and `cli/test/service-worker.test.mjs` asserts it by running the
generated handler against a seeded `CacheStorage` rather than by matching the source text.

**The worker does not `skipWaiting`.** A tab running last week's modules must not have this
week's worker answering its requests: the two disagree about which hash names what. The swap
is a moment the application chooses, which is what
[ADR-0089](0089-a-tab-learns-its-release-changed-at-a-commit-boundary.md) exists to make
knowable.

**`sw.js` is emitted before the inventory, so it is a file the build verified.** It is
`revalidate` for the reason `index.html` is, and it is the one script in the artifact whose
name may not move with its bytes — a registration names one URL for the lifetime of an
origin. `verifyPayload` therefore excludes it from the hash-naming and one-file-per-chunk
rules, which are true of chunks and not of it, and requires it by name instead.

**Registration is the application's call, in one library function.**
`registerServiceWorker()` in `@core/application/worker.js` is not a startup step: an
application not deployed as an artifact has no `/sw.js`, a development origin deliberately
has none, and a library that registered one anyway would be caching a dev server's bytes
under a policy it invented.

**The registration goes through a Trusted Types policy the build's CSP names.**
`ServiceWorkerContainer.register()` is a script-URL sink, and every artifact ships
`require-trusted-types-for 'script'`, so a bare string throws — and because
`registerServiceWorker()` answers every failure with `null`, the worker would never install
and nothing would say why. `cspForImportMap` therefore names `srl-worker` beside the three
template policies, and `@core/application/worker.js` creates it on the first registration:
same-origin URLs only, and nothing created at import time by a page that never registers. A
deployment that writes its own CSP has to name that policy too, which
`docs/guide/delivery.md` states.

## Consequences

**The cache turns over exactly when the precached bytes do**, because it is named after a
digest of the precache list. Naming it after the release would turn it over on deploys that
changed nothing a visitor downloads, and a build of an uncommitted tree has no release to
name it after at all — `ArtifactRelease` is null on both halves there, by design.

**Every artifact carries `sw.js` whether or not anything registers it.** Around two
kilobytes, inert until registered, and unconditional on purpose: a build flag would be a new
fact entering the build, which is the property that makes this generator cheap.

**The example application does not register it, and the reason is the benchmark.** A
registration changes the request graph three committed workloads measure —
`delivery/entry-route`, `delivery/lazy-*` and `delivery/lazy-routes-cached` count requests,
module requests and cache hits — and an install racing the measured window would make those
counts depend on timing rather than on delivery. Wiring the reference application is
therefore a change to the benchmark's declaration first, not a one-line edit to `main.js`.

**What would reopen this.** A precache list large enough that installing it is itself a
cost — which is a statement about the entry closure, and would be a reason to shrink that
closure rather than to write the list by hand. Or a deployment that serves an artifact's
`/assets/` and a Remote's from one prefix, which would make the anchored immutable rule
wrong; the fix there is the prefix, not the worker.
