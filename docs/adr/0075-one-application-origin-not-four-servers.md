# ADR-0075: One application origin, and the four servers are adapters over it

- Status: accepted
- Date: 2026-08-27
- Affects: `cli/origin/`, `cli/dev/serve.mjs`, `cli/test/support/artifact-origin.mjs`, `tools/benchmark/origin.mjs`, `web-test-runner.config.mjs`, `tools/checks/verify-deps.mjs`, `cli/test/origin.test.mjs`, `cli/test/serve-proxy.test.mjs`

## Context

Four things in this repository served one srl application, and each had written its own
answer to the same five questions — which mount claims a URL, may the resolved path leave
that mount, what is a directory answered with, when may a missing path be answered with
`index.html`, and what is a file's `Content-Type`.

- `cli/dev/serve.mjs` — development, with live reload and `--proxy`
  ([ADR-0069](0069-the-dev-server-proxies-the-backend.md)).
- `tools/benchmark/origin.mjs` — the origin under measurement, with a production cache
  policy and gzip.
- `cli/test/support/artifact-origin.mjs` — a built artifact plus its Remotes, with a
  rewritten entry document and a deliberately tampered byte.
- `web-test-runner.config.mjs` — the runner's mount rewrite, which resolves a prefix to
  another prefix rather than to a directory.

`toFilePath` was byte-identical in the first two. The third had a differently spelled
traversal check doing the same job. The history fallback disagreed three ways: the dev
server keyed it on `extname()`, the benchmark on `pathname.includes('.')`, and the
artifact origin ignored `Accept` altogether. The listen-and-close dance — bind to 0, ask
which port that was, refuse a non-TCP address, close all connections before the server —
was written three times, and getting the last part wrong is a suite that hangs after its
assertions have passed.

None of it was published, and none of it was tested. A repository that installs
`@srljs/cli` gets `@srljs/core/testing/harness.js` and has nothing to run it against: no
way to serve its own application to a browser suite, and so no way to test a component
against the origin its application actually has. The only suite that exercised any of
these rules did it by building a real artifact and driving a real Chrome, which is to say
the traversal guard — the one security rule in the toolchain — was asserted nowhere.

## Decision

`cli/origin/index.mjs` owns the rules, and it is published. Four options are what an
adapter states:

- `route` — the adapter's own endpoints, consulted before anything static.
- `transform` — a body to send instead of the file's bytes.
- `headers` — extra response headers for a static hit.
- `fallback` — the document a navigation with no file behind it gets.

Each caller keeps only what makes it different: the proxy and the reload injection, gzip
and a production cache policy, the rewritten entry document and the tampered byte, the URL
rewrite. `resolveMount` is exported separately for the fourth, which needs the resolution
rule without a filesystem.

**There is no `proxy` option, and there must not be one.** The development server's
`--proxy` is load-bearing and it is one caller's deployment; an origin whose interface
carried it would put that deployment in every caller's signature. It lives in that
adapter's `route`, which is consulted before the method check and before the mounts for
exactly the reason a proxy needs — a `POST /api/session` must not be answered 405 by a
server that is right to refuse a `POST` of a stylesheet. If `OriginOptions` ever grows a
`proxy` field, this deepening has failed and ADR-0069 has leaked.

**The history fallback is one rule now**: `Accept` names `text/html` *and* the path has no
extension. That is the stricter of the three, and both halves matter. A missing `.js` must
stay a 404 or a typo in an import silently returns HTML and the error becomes
`Unexpected token '<'` somewhere unrelated; a `fetch` of a missing endpoint must not be
handed a page either.

**A malformed request is a refusal, not a crash.** A bad percent escape and an embedded
NUL both used to reach `fs` and come back as a 500. They are 403s.

The rejected alternative was a shared `toFilePath` helper and nothing else — the smallest
change that removes the copied traversal guard. It leaves three servers each re-deciding
what a directory, a fallback and a cache policy are, which is where the drift actually
was, and it leaves an adopter with no origin to run a suite against. The seam is worth
having only if the thing behind it is a whole server.

## Consequences

The test-runner config no longer carries a hand-written import map. It reads the
application's own, the way it already did for every application that was not the default
one, so the two documents cannot diverge because there is one document. Check 5 of
`tools/checks/verify-deps.mjs` — `deps/test-map-diverges` and its siblings — is therefore
deleted: it existed to compare a copy, and a check that exists to compare a copy is paid
for by the copy. `5b` and `5c` take the numbers `5` and `5b`, and the failure mode the
header enumerates as 5 is now the CSP hash. The derived map drops the `/lib/vendor/`
integrity pins, as it already did for other applications: the runner serves those bytes
itself and `npm run vendor` asserts them.

`cli/dev/serve.mjs` exports `serveApplication` and its command block is guarded, so
`cli/test/serve-proxy.test.mjs` states its own backend in-process instead of spawning a
child and waiting for a startup line on its stdout. Six of its seven cases stopped
spawning; the seventh asserts an exit code and still has to.

`cli/test/origin.test.mjs` asserts the shared rules directly — the traversal refusal,
the segment boundary, the fallback, the method refusal, `HEAD`, and that a transform's
length is the transformed body's. No browser, no build, no application.

The published surface grew by one directory. `srl test` is another adapter and is not
here: choosing a browser test runner for an adopter is its own decision, and until it is
made an adopter builds its own origin over this module in four lines.

`example/server/static.mjs` was a fifth hand-written copy of these rules and was missed —
it is the server `npm run example:serve` starts, so it is the one a developer of the
example application actually looks at.
[ADR-0085](0085-source-delivery-announces-its-templates.md) folds it in, and adds
conditional requests to the rules this module owns.
