# ADR-0088: The service worker is generated from the artifact report

- Status: accepted
- Date: 2026-09-02
- Affects: `cli/delivery/service-worker.mjs`, `cli/delivery/build.mjs`, `cli/delivery/artifact-report.mjs`, `source/lib/core/application/worker.js`

## Context

The build classifies every emitted file as `immutable` or `revalidate`, and `artifact.json` records each file's class and hash. `verify-http`, `release` and the benchmark read that report. The browser never did, so a second load re-requested hash-named files and an offline tab had no shell.

A bundler plugin that globs the output directory would work the same facts out a second time, and the two copies would drift.

## Decision

`serviceWorkerSource(facts)` is a pure function from report facts to JavaScript, and the build emits its output as `sw.js`.

- The precache is the entry closure: the document, the modules the entry document preloads and the `entry` template group (ADR-0081). A first load fetches exactly that set anyway. `entryClosure` has one definition, in `artifact-report.mjs`.
- Every precached file except the document is fetched against its import-map pin, and the build refuses a precached file without one (ADR-0129).
- `/assets/` is cache-first. A response is stored only when its request carried integrity, so the cache holds verified bytes only. The document, `app.manifest.json`, `build.json` and `i18n/*.json` are network-first with a cache fallback. A navigation gets the shell. Everything else, remotes included, goes straight to the network.
- Cache names follow `srl:<app>:<digest>`, where the digest covers each precached URL with its pin. Activation deletes only caches under this application's prefix, because other applications and remotes may share the origin.
- `srl build --worker retire` emits a retiring worker as `sw.js`. It skips waiting, deletes this application's caches, unregisters and answers nothing, so it retires every installed worker at the next navigation.
- The worker doesn't call `skipWaiting`, because a tab running old modules must not be served by a new worker (ADR-0089).
- Registration is the application's choice, through `registerServiceWorker()`. It goes through the `srl-worker` Trusted Types policy, which the build's CSP names.

## Consequences

- The cache turns over only when the precached bytes change, even under an unchanged URL.
- On an engine that ignores import-map pins, module requests carry no integrity, so their responses are not cached.
- Every artifact carries a `sw.js` of about 2 KB, whether or not anything registers it.
- The example doesn't register it, because a worker would change the request counts the benchmark gates on.
- A deployment that serves a remote's files under `/assets/` would break the cache-first rule.
