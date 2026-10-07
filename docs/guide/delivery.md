# Development and production delivery

The development server runs the source files directly. The production build
creates a verified artifact from the same application.

```bash
npx --no-install srl serve --app web --open
npx --no-install srl build --app web
```

The dev server serves the application, `/lib/`, and `/components/` on one
origin, supports history fallback, and sends updates to open pages. In this
repository, `npm start` serves the example and `npm run build -- --app example`
builds it. The example's Node server also serves its API and sign-in routes.

The dev server binds 127.0.0.1 and answers only requests addressed to
`localhost`, `*.localhost` or an IP address. `--host 0.0.0.0` opens it to the
network, and `--allowed-host <hostname>` adds a name such as one from
`/etc/hosts`. Both are for a network you trust.

## Where a build writes

`srl build` writes `dist/<app>` by default, and `--out <dir>` names another
directory. The build replaces that directory only when it is new, empty, or
holds the `artifact.json` a previous build wrote. `--force` replaces any other
directory, but never one that holds the project or your home directory.

```bash
npx --no-install srl build --app web --out /tmp/web
npx --no-install srl build --app web --out build/web --force
```

Every file the build writes stays inside its output directory, and a symbolic
link in the tree can't carry a write out of it. A component tag or locale URL
that would name a path outside it fails the build. ADR-0132.

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
npx --no-install srl build --app web
npx --no-install srl build --app web --templates split-lazy
npx --no-install srl build --app web --templates bundle
```

`split` avoids serial template requests within a code chunk. It starts only
the entry group's markup before the first route; a guarded route's templates
wait until its chunk loads. `split-lazy` transfers the least markup for a
visitor who opens few screens, with more request latency. `bundle` makes one
request but refetches the whole bundle when any template changes. The
[template guide](templates.md#loading-and-caching) explains runtime caching.

Every mode still emits individual immutable template files. The build checks
that minification leaves each template's parsed structure intact. A template
the build's HTML parser reads differently from a current browser, such as a
`<select>` holding a `<button>`, ships unminified.
`srl templates --app web` writes a separate authored-byte bundle for a
deployment that skips the production build. It prints the bundle's pin, which
the application's import map must carry, because admission refuses a bundle the
page doesn't pin.

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
precaches the entry graph and its templates, each fetched against its
import-map pin. Hash-named assets use cache-first, and the worker stores a
response only when its request carried integrity. Fixed URLs use
network-first with an offline fallback. The worker leaves remote assets to
their own deployer.

An application opts into registration after startup.

```js
import { registerServiceWorker } from '@srljs/core';

await startApplication({ /* … */ });
await registerServiceWorker();
```

The worker does not call `skipWaiting()`, so an older tab keeps a worker
matched to its modules. `watchRelease()` reads `build.json` at navigation
commit boundaries and sets `releaseChanged` when the origin serves a new
release. The application decides how to tell the user.

To retire every installed worker, build with `--worker retire` and deploy
that artifact. Its `sw.js` skips waiting, deletes the application's caches,
unregisters and sends every request to the network. Browsers check the worker
script on each navigation, so open tabs switch over without a reload. Deploy a
normal build again when the origin is trusted.

```bash
npx srl build --worker retire
```

## The pin table

The integrity block of the production import map pins every byte the page
runs: chunks, templates, the template bundle, locale files, the stylesheet and
every composed remote asset. Every loader fetches under its pin, so a changed
file fails its request. Admission refuses a manifest that names a remote asset,
remote template, template bundle or locale file the map doesn't pin.
[ADR-0129](../adr/0129-one-pin-table-for-every-byte-the-page-runs.md) records
the rule.

Browsers apply import-map pins only to modules, and some engines ignore them.
Before the first remote loads, the runtime imports a probe module pinned to the
digest of zero bytes. An engine that enforces pins refuses it, which Chromium
logs as one console error. An engine that loads it runs no remotes, and the
error names the engine. The probe's pin is part of the library's import-map
fragment, so `srl importmap` prints it.

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

In this repository, run the package build and repository checks before
inspecting a tarball.

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
This repository's `npm run vendor` checks the committed bytes, and its fetch
mode refuses a download whose hash differs from the recorded value.

## Third-party notices

The repository ships `source/lib/vendor/LICENSES.md` with its vendored code.
`npm run vendor` checks those notices against the pinned package licenses.
A production build writes `THIRD_PARTY_LICENSES.md` for code in its artifact,
including Tailwind CSS produced by the CLI. Each distribution therefore carries
notices for the third-party bytes it serves.

## Deployment checks

A strict CSP needs the hash of the inline import map in `script-src`.
The build's CSP also sets `form-action 'self'` and `object-src 'none'`.
`srl check importmap` reports that hash under `importmap/csp-hash`. When configuring nginx, set security
headers where all relevant responses inherit them; a `location` with its
own `add_header` directives can replace headers set at server level.

The production Tailwind input uses `source(none)` and explicit scan paths.
This keeps the vendored browser compiler out of the scan. Tailwind also scans
comments for class names, so examples of utility classes in source comments
can add unused CSS.

Class interpolation works for groups of Tailwind classes.
`classMap` keys pass through `DOMTokenList` and must each be one token.
