# ADR-0075: One application origin, with every server as an adapter

- Status: accepted
- Date: 2026-08-31
- Affects: `cli/origin/`, `cli/dev/serve.mjs`, `cli/test/support/artifact-origin.mjs`, `tools/benchmark/origin.mjs`, `example/server/static.mjs`, `web-test-runner.config.mjs`

## Context

Five servers in this repository serve an srl application: the dev server, the benchmark origin, the artifact test origin, the test runner's rewrite and the example's static server. Each once answered the same questions on its own. Which mount claims a URL? May the path leave the mount? What does a directory return? When does a missing path fall back to `index.html`? What is the `Content-Type`?

The answers drifted. The history fallback disagreed three ways, and the traversal guard, the toolchain's one security rule, had no test. An adopter also had no origin to run browser tests against.

## Decision

`cli/origin/index.mjs` owns the rules and is published. An adapter supplies up to four options.

- `route` handles the adapter's own endpoints, before static files.
- `transform` supplies a body to send instead of the file.
- `headers` adds response headers.
- `fallback` names the document a navigation gets when no file matches.

The origin enforces three shared rules.

- The history fallback applies only when `Accept` names `text/html` and the path has no extension, so a missing `.js` stays a 404.
- A bad percent escape or an embedded NUL gets a 403.
- A file carries a weak `ETag` built from its size and mtime, and a matching `If-None-Match` gets a 304.

The origin has no `proxy` option. `srl serve --proxy <prefix>=<origin>` is the dev server's own `route`. It forwards the request and passes status and headers back unchanged, rewriting only `Host`. The prefix isn't stripped and matches whole path segments, so `/api` never matches `/apiary`. The proxy runs before the method check and the fallback, so `POST /api/session` reaches the backend and a missing endpoint 404s from the backend. An application whose session is a backend cookie develops on one origin, the same way it deploys.

## Consequences

- Each server keeps only what makes it different, such as proxying, gzip, a cache policy or a tampered byte for a test.
- `cli/test/origin.test.mjs` tests the shared rules without a browser.
- Development servers send `no-cache`, so a reload revalidates instead of downloading everything again.
- An edit that changes neither size nor mtime is missed until the file is touched.
