# Development and production delivery

The development server runs the source files directly. The production build
creates a verified artifact from the same application.

```bash
node cli/dev/serve.mjs --app example --open
npm run build -- --app example
```

The dev server needs no install. It serves the application, `/lib/`, and
`/components/` on one origin, supports history fallback, and sends updates
to open pages. The example's Node server also serves its API and sign-in routes.

## Templates in a built artifact

The build emits minified, hash-named template files. A component loads its
template when its code runs. The `--templates` option controls what the
manifest announces before that point.

| Mode | Manifest | Loading |
|---|---|---|
| `split` (default) | `templateGroups` | Starts entry templates at startup and starts each later group with its code chunk. |
| `split-lazy` | Empty `templateFiles` | Discovers each template when its component runs. |
| `bundle` | `templateBundle` | Fetches one bundle and seeds the cache before mounting. |

```bash
npm run build -- --app example
npm run build -- --app example --templates split-lazy
npm run build -- --app example --templates bundle
```

`split` avoids serial template requests within a code chunk. It starts only
the entry group's markup before the first route; a guarded route's templates
wait until its chunk loads. `split-lazy` transfers the least markup for a
visitor who opens few screens, with more request latency. `bundle` makes one
request but refetches the whole bundle when any template changes. The
[template guide](templates.md#loading-and-caching) explains runtime caching.

Every mode still emits individual immutable template files. The build checks
that minification leaves each template's parsed structure intact.
`npm run templates` offers a separate authored-byte bundle for a deployment
that skips the production build.

## Templates in development

Development has no code chunks. Its server builds a flat `templateFiles`
list from the project model and starts those requests during startup. A
remote's templates are announced by that remote's entry after its guard runs.

Responses use `Cache-Control: no-cache` and ETags. A reload can reuse unchanged
files after revalidation. The development update session sends a saved file's
browser URL to open pages. Template edits revise mounted components, component
style edits replace their rules, and linked stylesheet edits swap their links.
Other edits reload the page. A reconnecting page receives missed edits or a
reload after the server restarts.

A bare `python3 -m http.server` cannot mount the application and library at
their required paths on one origin. The CLI dev server and the example backend
both use `cli/origin/` for that mapping.

## Entry document and worker

The production build adds a manifest preload and modulepreload hints for the
entry graph and root component. Each hint uses the same integrity digest as
the module request. Hints move transfer earlier without changing evaluation
order or the startup steps.

```html
<link rel="preload" href="/app.manifest.json" as="fetch" crossorigin>
<link rel="modulepreload" href="/assets/app-root-BetDmK3e.js"
      crossorigin integrity="sha384-…">
```

The build also generates `public/sw.js` from the artifact report. It
precaches the entry graph and its templates. Hash-named assets use
cache-first; fixed URLs use network-first with an offline fallback. The
worker leaves remote assets to their own deployer.

An application opts into registration after startup.

```js
import { registerServiceWorker } from '@core/application/worker.js';

await startApplication({ /* … */ });
await registerServiceWorker();
```

The worker does not call `skipWaiting()`, so an older tab keeps a worker
matched to its modules. `watchRelease()` reads `build.json` at navigation
commit boundaries and sets `releaseChanged` when the origin serves a new
release. The application decides how to tell the user.

## Example deployment

The live [Meridian demo](https://srl-example.santella.dev) serves readable
source. nginx serves the application, library, and components and proxies
`/auth` and `/api` to the Node process on the same hostname. The process
runs `example/server/server.mjs --api-only`, so it does not need the CLI
static adapter in the deployed tree. The workflow deploys after repository
checks pass.

## Publishing the packages

`source/` is published as `@srljs/core`; `cli/` is the separate toolchain
package. The core tarball serves two consumers.

| Consumer | Resolution | Files |
|---|---|---|
| Browser with an import map | Published import-map fragment | Source modules, components, and sibling templates. |
| Node or a bundler | Package `exports` | Generated core and component bundles with declarations. |

Run the package build and repository checks before inspecting a tarball.

```bash
npm run package
npm run check
cd source && npm pack --dry-run
```

`source/dist/` is generated. An export marked `@internal` stays available
through its source module path but leaves the flat bundle namespace. The
package build checks that another bundle does not still import that name.

## Vendored dependencies

The browser loads committed Lit, signals, and development Tailwind files from
`source/lib/vendor/`. Their provenance and hashes live beside them.
Import-map integrity pins apply to these same-origin files in the browser.
`npm run vendor` checks the committed bytes; its fetch mode refuses a
download whose hash differs from the recorded value.

## Third-party notices

The repository ships `source/lib/vendor/LICENSES.md` with its vendored code.
`npm run vendor` checks those notices against the pinned package licenses.
A production build writes `THIRD_PARTY_LICENSES.md` for code in its artifact,
including Tailwind CSS produced by the CLI. Each distribution therefore carries
notices for the third-party bytes it serves.

## Deployment checks

A strict CSP needs the hash of the inline import map in `script-src`.
`npm run verify` computes that hash. When configuring nginx, set security
headers where all relevant responses inherit them; a `location` with its
own `add_header` directives can replace headers set at server level.

The production Tailwind input uses `source(none)` and explicit scan paths.
This keeps the vendored browser compiler out of the scan. Tailwind also scans
comments for class names, so examples of utility classes in source comments
can add unused CSS.

Class interpolation works for groups of Tailwind classes.
`classMap` keys pass through `DOMTokenList` and must each be one token.
