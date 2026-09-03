# Development and production delivery

The repository **is** a deployable artefact.

```bash
node cli/dev/serve.mjs --open          # zero dependencies, watch + live reload
node cli/dev/serve.mjs --app example   # the default; name another application
npm run build -- --app example           # verified artifact: the served shape
npm run css                              # the one build step: production Tailwind
npm run templates                        # buildless deployments: N template requests -> 1
```

## Templates in a built artifact

Each template is emitted as one immutable, hash-named file, minified, and fetched by the
component that names it when its chunk loads. A visitor downloads the markup of the routes
they open, and a template that did not change is not re-fetched after a deploy that changed
another.

```bash
npm run build -- --app example                          # default: split
npm run build -- --app example --templates split-lazy   # announce nothing
npm run build -- --app example --templates bundle       # plus templates-<hash>.json
```

All three emit exactly the same thing — one immutable, hash-named file per template — and
differ only in what the manifest says about them, which is the whole cost. A component names
its own template, so a URL is unknowable until that component's module has arrived and run.
Nine components in one chunk are otherwise nine requests in a row inside one 12 KB file,
with the router's next level waiting on all of them.

| | manifest key | startup | first visit, example app |
|---|---|---|---|
| `split` | `templateGroups`, every URL, grouped by chunk | starts the `entry` group, waits for none; every other group starts when its chunk does | 3 requests, 5.5 KB signed out; 24 requests signed in |
| `split-lazy` | `templateFiles: []` | nothing to do | 20 requests, 8,180 B |
| `bundle` | `templateBundle`, one URL | fetches and seeds it, **awaits it** | 1 request, 12,698 B |

```json
{
  "templateGroups": {
    "entry": ["/assets/templates/app-root-ae669edf0e5aa032.html", "…"],
    "chunk:assets/shell-layout-BCQ4fpba.js": ["/assets/templates/ui-card-6b1d4f0a2c8e5713.html", "…"]
  }
}
```

**The group is what makes the list actionable.** A flat list can only be started at once,
before any route is known: on the example application that is 50 requests at step 3 when
the first paint reaches three of them. Grouped by the chunk whose modules name each
template, startup starts the `entry` group — the closure the entry document already
preloads — and leaves the other 35 registered
([ADR-0086](../adr/0086-the-manifest-groups-templates-by-chunk.md)).
`admitManifest` still derives the flat `templateFiles` union from the groups, so code that
wants every template this artifact holds reads one property as before.

**A group starts when its chunk does.** `defineComponent` calls `attachTemplate` from the
module body, which is the one place that knows which chunk is running, and that call starts
the whole group before it awaits its own template: nine components in one chunk cost one
batch of nine requests rather than nine in a row. The entitlement follows for free — a chunk
evaluates only because something imported it, and a route chunk is imported downstream of the
`canActivate` that gates its route, so markup a guard refused is markup nobody fetched. On the
example application a visitor at the login form fetches 3 templates instead of 50, and a
signed-in session that opens the dashboard and the orders list fetches 24. The cost is one
round trip on the first navigation into a chunk, because its markup now leaves after the code
rather than before it
([ADR-0087](../adr/0087-a-template-group-starts-with-the-chunk-that-names-it.md)).

**`split` is the default** because the cost it removes is latency rather than bytes. Against
`split-lazy`, measured to first paint: 59 ms slower at zero added round-trip time, 207 ms
faster at 40 ms, 547 ms faster at 100 ms. The sign flips near zero, which is the one regime
real users are never in — and the one `tools/benchmark` runs in, so read its byte budgets
with that in mind.

**`split-lazy` is [ADR-0071](../adr/0071-a-built-template-is-fetched-by-the-component-that-needs-it.md)
unchanged**: a visitor downloads the markup of the routes they open and nothing else. It is
the right mode for a metered connection, or an application whose visitors open one page.

**`bundle` moves the fewest bytes**, which is not obvious: fifty separately compressed files
are 22,858 B brotli where the same markup as one JSON is 12,698 B, because fifty brotli
streams share no dictionary and each pays its own framing. It buys that with cache
granularity — the filename hash covers every template, so changing one re-fetches all of
them — and by blocking startup step 3 where the other two do not. Its individual files are
still emitted and simply never fetched, since seeding short-circuits the network.

The axis is first visit against repeat visits, and
[ADR-0081](../adr/0081-the-manifest-names-every-template.md) has the measurements.

Production markup is not the authored markup: comments and indentation are dropped, and
every build proves the result parses to the same tree the source did before it can be
emitted ([ADR-0070](../adr/0070-a-production-template-is-minified-and-proved-equivalent.md)).
A third of the markup is whitespace and prose in practice. What that transform will not
touch, and how to tell it that whitespace matters, is in
[the template guide](templates.md#whitespace-in-production).

`npm run templates` is the other path: the optional `<app>/templates.json` for a deployment
with no build step at all. It writes authored bytes, minifies nothing, and
[ADR-0042](../adr/0042-the-template-bundle-is-per-application.md) is why.

## Templates in development

A flat list, from a different producer. `templateFiles` is what makes startup step 3 run
at all, and a source tree has no bundler to write it — nor any chunks to group it by, so
development announces the whole list and startup starts the whole list — so the development
servers compute it from `cli/project-model/`, the same list `npm run templates` bundles
and `npm run verify` checks against. `cli/delivery/source-manifest.mjs` is the second
producer; the runtime path is the one above, unchanged, and the browser cannot tell which
module wrote the manifest it fetched.

```json
{ "templateFiles": ["/src/app-root.html", "/components/data/ui-table.html", "…"] }
```

Without it the templates step is skipped and every template is discovered the slow way: a
chunk's module body runs, learns its own template URL, awaits it, and only then does the
next module body run. Nine components in a chunk is nine round trips in a row, on every
reload — the exact chain `split` closed for production, left open where the editing
happens.

A Remote's markup is announced on that Remote's entry and never on the shell, the way the
build announces it. The router runs a Remote's guard before `prepareRemote`, and markup
the shell had already fetched is the request that guard exists to refuse.

An application that set `templateBundle` by hand keeps it: the runtime prefers seeding
over a list, so a list beside a bundle is requests nothing reads. And a project the model
cannot parse — a half-typed module, a clone with no `node_modules` — costs the
announcement and never the server: the manifest on disk is served unchanged, one round
trip per template slower.

**Reloads revalidate.** Both servers state `Cache-Control: no-cache` and `cli/origin/`
sends an `ETag` built from each file's size and mtime, so a reload is a 304 for every file
the developer did not touch and a whole body for the one they did. Measured on the example
application: **776,793 B over 54 requests, every reload** under the old `no-store` — which
deleted the browser cache and made the second reload cost exactly what the first did —
against **30,300 B over 101 requests** now. More requests, because the 50 templates are
now started up front; a fiftieth of the bytes, because all of them revalidate.

`cli/dev/serve.mjs` exists because requiring `npm install` before the app could be
*run* would make the project look like it has a toolchain it does not have. What a server
has to provide is correct MIME types, a history fallback so a reload on `/users/3` returns
`index.html`, two directories mounted on one origin, and watch-and-reload. Only the last
two are more than a file handler, and the nginx equivalent is two `alias` blocks and a
`try_files`. It is an adapter over `cli/origin/`, and so is `example/server/static.mjs`,
which is the one `npm run example:serve` starts: an application with a backend needs its
API same-origin with the page, so it serves its own files rather than being proxied to
([ADR-0075](../adr/0075-one-application-origin-not-four-servers.md)).

`python3 -m http.server` does not serve this repository: an application directory and the
library have to appear at `/` and `/lib/` on one origin, and mounting two directories is
the single thing a bare file server cannot do. Every real static host can — nginx with
`alias`, Caddy with `handle_path`, S3 with a copy step, which is what the release step does.

npm is still how the *tooling* is installed: tsc, ESLint, the test runner, the Tailwind
CLI. None of it is needed to serve the application.

## What the entry document names

A built `index.html` is not only a pruned copy of the authored one. After the module graph
exists, the build projects it back onto the document: a `preload` for `app.manifest.json`,
which is startup step 2, and a `modulepreload` for the entry chunk's static closure and for
the root module the last startup step always imports.

```html
<link rel="preload" href="/app.manifest.json" as="fetch" crossorigin>
<link rel="modulepreload" href="/assets/reactive-CDx66i8u.js" crossorigin integrity="sha384-…">
<link rel="modulepreload" href="/assets/app-root-BetDmK3e.js" crossorigin integrity="sha384-…">
```

Without them a cold start discovers its own dependency graph one round trip at a time —
fetch the entry, evaluate it, learn the next URL — and six to eight of the round trips
before the first routed view exist for no other reason. Nothing about evaluation order
changes: a hint moves the transfer, not the execution, so the seven startup steps keep
their order and their guarantees.

Each digest is the one the page's own import map already pins for that URL, so the hint and
the module request it is for are one transfer rather than two.
[ADR-0080](../adr/0080-the-entry-document-names-the-graph.md) has the whole decision,
including why route chunks and locale bundles are deliberately not named.

## The worker the build generates, and the release a tab is running

Every build emits `public/sw.js` beside the bytes it describes. It is generated from the
artifact's own facts rather than by walking the output directory: the precache list is the
document, its stylesheet, the entry chunk's static closure and the root module it always
imports, and the markup those modules define — the same closure the `modulepreload` hints
above are derived from, computed once in `entryClosure` and read by all three consumers.

```js
const PRECACHE = [
  "/index.html",
  "/assets/index-Igztw2eg.css",
  "/assets/app-root-BmsFBqLr.js",
  "/assets/entry-C71ACrhs.js",
  ...
  "/assets/templates/login-page-32bc7914e98576f1.html"
];
```

The fetch handler restates the cache classes `cacheClass()` already assigned: hash-named
`/assets/` is cache-first, the fixed URLs — the document, `app.manifest.json`, `build.json`,
`i18n/*.json` — are network-first with the cache as the offline fallback, and a navigation
is answered by the shell whatever path it names. Everything else is left on the network
untouched, which is how a Remote's bytes stay its deployer's: a Remote publishes under
`/remotes/<name>/<version>/`, and the immutable rule is anchored at `/assets/` so it cannot
match one.

Nothing registers it for you. `registerServiceWorker()` from `@core/application/worker.js`
is one call an application makes after startup, because a development origin has no `/sw.js`
and a library that registered one anyway would be caching a dev server's bytes.

```js
import { registerServiceWorker } from '@core/application/worker.js';

await startApplication({ /* … */ });
await registerServiceWorker();
```

The worker deliberately does not `skipWaiting`: a tab running last week's modules must not
have this week's worker answering its requests. So the other half of a deploy is knowing one
happened, which is what `build.json` is for and what `@core/application/release.js` reads.

```js
import { releaseChanged, watchRelease } from '@core/application/release.js';

watchRelease();     // reads /build.json at commit boundaries, throttled
// releaseChanged.value becomes true, once, when the origin serves a different release
```

The read happens when a navigation commits — the one instant the tab could act on the
answer — and at most once a minute. The library decides when the fact is true; what a banner
says, and whether it offers a reload or takes one at an idle moment, is the application's.
[ADR-0088](../adr/0088-the-service-worker-is-generated-from-the-artifact-report.md) and
[ADR-0089](../adr/0089-a-tab-learns-its-release-changed-at-a-commit-boundary.md) have both
decisions, including why the example application calls neither: a registration and a
per-navigation read both move request counts three committed benchmark workloads gate on.

## The example's deployment

[srl-example.santella.dev](https://srl-example.santella.dev) is deployed by
`.github/workflows/deploy.yml` on every push to `main`, and the push is the repository:
no bundler, no minifier, nothing hash-named. The browser fetches the same
`src/pages/sales/sales-page.js` a clone serves, which is the property that makes the demo
worth having — what is deployed is readable, and the source of a bug is one View Source
away.

It hangs off the `check` workflow with `workflow_run` rather than off the push itself, so a
tree that fails `npm run check` is never pushed. That command is the gate, and the two
failures it exists to catch here are the ones that arrive as a blank page rather than as a
build error: an import map that omits a specifier, and a component template that does not
exist.

The job installs nothing. The browser's three dependencies come from `source/lib/vendor`,
which is committed; the API is zero-dependency Node; and the mount table comes from
`node cli/layout.mjs --deploy-pairs`, which runs before any `npm install` by design. So the
whole deployment is a stamp, two rsyncs and a restart:

```
/home/ubuntu/www/srlexample/             <- example/, minus test/ and src/app.css
/home/ubuntu/www/srlexample/lib/         <- source/lib/
/home/ubuntu/www/srlexample/components/  <- source/components/
```

`example/server/` lands inside that web root because that is where supervisor's program
line points at it: `[program:srlexample]` runs `server/server.mjs --port 8100 --api-only`,
and `--api-only` is what keeps it from importing `cli/origin/` and the mount table behind
it, a development directory the deployed tree omits. nginx serves the static tree and proxies `/auth` and `/api` to
8100 **on the site's own hostname**: the session cookie is `HttpOnly` and same-site, so a
second port or a second host signs every visitor out
([ADR-0069](../adr/0069-the-dev-server-proxies-the-backend.md)).

Three repository secrets, the same three the deploy of any other static tree needs:
`HOST`, `USERNAME` and `PRIVATE_KEY`. The remote user needs passwordless
`sudo supervisorctl` for that one program and nothing else.

`deploy*.sh` at the root is the same shape by hand, for a target that is not this one. It
is gitignored, because what such a script holds is a host and a credential path rather
than repository content.

## Publishing the package

The other delivery direction: `source/` is the package `@srljs/core`, and a consumer
installs it rather than deploying it.

```bash
npm run package                          # source/dist: the four bundles exports names
npm run check                            # runs the above, then verifies the map matches
cd source && npm pack --dry-run          # what the tarball would contain
cd source && npm publish                 # publishConfig already sets --access public
```

Two shapes go out in one tarball, because there are two ways to resolve the library and
only one of them exists in a browser:

| Consumer | Reaches the library through | What ships |
|---|---|---|
| A browser with an import map | `lib/importmap.json`, pasted or fetched | `lib/` and `components/` as source, templates fetched beside their modules |
| Node, or a bundler | `exports` | `dist/srl-core.js` and `dist/srl-components.js`, minified pairs beside them, templates inlined |

`dist/` is generated and not committed, exactly like an application's `app.css`. It has to
exist before `npm publish`, and `npm run verify` fails naming the command when `exports`
points at a file that is not there, so a release cannot ship a map that reaches outside its
own tarball. Why the second shape exists at all, and what it deliberately does not carry
(TypeScript declarations), is
[ADR-0066](../adr/0066-the-registry-consumer-gets-bundles.md). What a version bump means is
[the changelog](../../CHANGELOG.md).

### Keeping a name out of the bundle

The bundles are barrels the build walks, never lists, so a module added under `@core/`
reaches the second consumer with no edit anywhere. What that consumer is *offered* is the
module's own answer: mark an export `@internal` in the doc comment directly above it and
the name leaves the bundle's namespace.

```js
/**
 * Compile template source into a render function.
 *
 * Exported for tests; application code goes through `loadTemplate`.
 *
 * @internal
 */
export function compileTemplate(source, where) {
```

Nothing becomes unreachable. The import-map consumer loads modules by path and sees every
export it always did, and so does `srl check templates`, which shares the template dialect
with the runtime by importing it. It is the flat namespace of `import { … } from
'@srljs/core'` that is curated, because that is the only place a name reads as an offer —
[ADR-0077](../adr/0077-a-module-declares-which-exports-are-the-door.md).

One thing to know before marking: a name `components/` imports is one `srl-components`
reaches through `./srl-core.js`, so marking it there would ship a pair of bundles that
throws on first import. `npm run package` refuses that build and names the export.


## Vendored dependencies

```
source/lib/vendor/lit-all.min.js        sha384-qSoE0an…
source/lib/vendor/signals-core.mjs      sha384-keryyWs…
source/lib/vendor/tailwind-browser.js   development only, never served in production
```

Import-map `integrity` is enforced by the browser for same-origin paths exactly as it is
for CDN URLs — verified by pointing a local module at a deliberately wrong hash and
watching the load fail. The hashes are a **runtime control**, not just a CI checksum: a
tampered `/lib/vendor` does not execute. `vendor/provenance.json` records upstream URLs,
and `npm run vendor -- --fetch` re-downloads and refuses to write anything whose bytes do
not match the recorded hash.

`@tailwindcss/browser` is pinned to `dist/index.global.js`, the real published file,
rather than the bare package URL that resolves to a jsDelivr-generated
`index.global.min.js`: generated artefacts cannot be SRI-pinned. `lit-all.min.js` logs a
console notice suggesting the npm package instead; it is the bundle that keeps all
directives in one module, which is what preserves a single Lit instance across the shell
and every remote.

## Third-party notices

Two delivery shapes redistribute third-party code, and each needs its own notice.

| Shape | File | Produced by |
|---|---|---|
| The repository, served from source | `source/lib/vendor/LICENSES.md` | `npm run vendor -- --write-licenses`, committed |
| A production artifact | `THIRD_PARTY_LICENSES.md` at the artifact root | `npm run build`, from the bundled module graph plus the Tailwind CLI |

The source path needs a file of its own because the vendored bytes mostly carry no notice
themselves: `signals-core.mjs` has no header at all, and the only licence string inside
`tailwind-browser.js` is the banner it injects into compiled CSS, not a notice for the
script. Only `lit-all.min.js` keeps upstream's `@license` headers. MIT and BSD-3-Clause
both require the notice to travel with the copy, and a committed file is a copy, so
`npm run vendor` fails when `LICENSES.md` disagrees with the `LICENSE` of the pinned
version in `node_modules` — the same shape as the hash check, for the same reason.

Every vendored package is therefore a devDependency pinned exactly, `@tailwindcss/browser`
included, even though nothing imports it and tsc never types it: `npm run verify` needs
its `LICENSE` to check the notice against. `provenance.json` records the SPDX identifier
per file and, for `lit-all.min.js`, the four packages the bundle contains, since naming
only the one it is published under would leave three copyright holders unacknowledged.

The build path is separate and generated: Vite extracts notices from the bundled
JavaScript, and `emitLicenses` appends Tailwind's, which enters through the CLI rather
than the module graph. `npm run build` fails if the file is not emitted.

## Deployment traps, each found by running it

- **An import map is an inline script, so a strict CSP blocks it.** `script-src 'self'` is
  correct for every *file* and fatal for the map. The failure is nasty: the page loads,
  `app.css` applies, `/src/main.js` returns 200, and everything dies on `Failed to resolve
  module specifier "@core/foundation/env.js"` — a blank page, an error pointing at module
  resolution, no visible CSP violation. The config carries a `sha256-` of the map's exact
  text and `npm run verify` recomputes it.
- **nginx does not merge `add_header`.** A directive in a `location` block replaces every
  header inherited from `server`, and `always` does not change that. Setting
  `Cache-Control` in four `location` blocks silently dropped the CSP from every page.
  `nginx -t` reports nothing. The config computes `Cache-Control` with a `map` and sets
  every header once, at server level.
- **Vendoring a CSS framework's compiler into a scanned directory quadruples the CSS.**
  Tailwind v4 walks the project and skips what is in `.gitignore`; `/lib/vendor` is
  committed, so Tailwind scanned its own engine, found every utility name it can generate
  and emitted them all. Fixed with `@import 'tailwindcss' source(none)` plus explicit
  `@source` globs.
- **Tailwind scans comments.** A component documented by showing its classes puts those
  utilities into every application's stylesheet, whether or not any application uses them.
  It scales with the collection rather than with usage. Measured in both directions:
  removing the design-notebook prose from `source/` dropped `.grow` — a bare word in one
  sentence, not a class anything binds — out of every application stylesheet, 22,001 to
  21,983 and 25,467 to 25,449 bytes for the two that existed when it was measured.
- **`classMap` is a poor fit for Tailwind** and is not used: its keys go through
  `DOMTokenList`, so a group like `'bg-sky-100 font-medium'` throws at render time.
  Attribute interpolation (`class="rounded {{ toneClasses }}"`) does the same job.

The application has been booted from an nginx config in the shape it is
meant to be deployed in: `nginx -t` clean, the browser Tailwind script commented out and
`<link rel="stylesheet" href="/app.css">` in its place, both `alias` mounts serving,
`/lib/` staying a 404 for a path that does not exist while `/users/3` falls back to
`index.html`, `Cache-Control: public, max-age=31536000, immutable` on `/lib/vendor` and
`no-cache` on the page, and the CSP and Trusted Types header in force with zero violations
and zero console errors. Only `/auth/*` and `/api/*` are missing there, which is the one
thing a static server cannot answer and `npm run example` exists for.
