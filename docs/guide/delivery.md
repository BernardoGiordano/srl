# Development and production delivery

The repository **is** a deployable artefact.

```bash
node cli/dev/serve.mjs --open          # zero dependencies, watch + live reload
node cli/dev/serve.mjs --app example   # the default; name another application
npm run build -- --app example           # verified artifact: the served shape
npm run css                              # the one build step: production Tailwind
npm run templates                        # optional: N template requests -> 1
```

`cli/dev/serve.mjs` exists because requiring `npm install` before the app could be
*run* would make the project look like it has a toolchain it does not have. What a server
has to provide is correct MIME types, a history fallback so a reload on `/users/3` returns
`index.html`, two directories mounted on one origin, and watch-and-reload. Only the last
two are more than a file handler, and the nginx equivalent is two `alias` blocks and a
`try_files`.

`python3 -m http.server` does not serve this repository: an application directory and the
library have to appear at `/` and `/lib/` on one origin, and mounting two directories is
the single thing a bare file server cannot do. Every real static host can — nginx with
`alias`, Caddy with `handle_path`, S3 with a copy step, which is what the release step does.

npm is still how the *tooling* is installed: tsc, ESLint, the test runner, the Tailwind
CLI. None of it is needed to serve the application.

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
