# @srljs/cli

The toolchain for a repository built on [**@srljs/core**](https://www.npmjs.com/package/@srljs/core):
a zero-config dev server, the project model static discovery reads, the template checker, and
the production artifact build and release pipeline.

Nothing here is needed to *run* an srl application — a browser with an import map loads the
library as source and never runs a build. This package is for the repository that deploys
one: it turns a directory with an `index.html` into minified, hash-named, integrity-pinned
chunks and a report describing them.

Full documentation, the guides and the decision records are in
[the repository](https://github.com/BernardoGiordano/srl).

## Install

```bash
npm install --save-dev @srljs/cli
srl new web
```

`srl new` writes the smallest application that builds: the document with the library's
import map pasted and the vendored script hashed, an entry module and a lazy chunk with
their templates, the stylesheet, the manifest, a locale bundle, and a `tsconfig.json`
extending the published base. Nine interdependent files, each of them a contract the tools
below enforce — so they come from one module, the same one this toolchain's own packaged-
install probe drives end to end on every run, rather than from prose here for you to
retype. It refuses rather than overwrites.

`@srljs/core` is a peer dependency, pinned to the exact matching version: this package reads
the library's own manifest for the mounts and specifier prefixes, and imports three of its
modules outright, so the two are one interface split across two tarballs.

Published separately for one reason. The build needs Vite, parse5 and the TypeScript
compiler API, and the consumer this framework is actually for — a page with an import map
and no build step — must not have to install a bundler to load a library that never runs
one. `@srljs/core` keeps its two runtime dependencies.

## What a repository looks like

An application is any directory in your repository root with an `index.html`. Nothing is
configured; the tools discover them.

```
your-repo/
  package.json
  web/               <- an application
    index.html
    app.manifest.json
    src/
  node_modules/@srljs/core/       served at /lib/ and /components/
```

Every tool takes `--app <dir>`, or `APP=<dir>`. With one application the flag is optional;
with two it is required, because a tool that picks one silently deploys the wrong thing
sooner or later.

The repository root is the working directory. Set `SRL_ROOT` only for the arrangement
neither default covers — a repository that vendors or submodules an srl checkout somewhere
below its own root.

## The tools

```bash
# A new application in the repository root. Refuses an existing directory; leaves an
# existing tsconfig.json alone and says which `include` entry to add.
srl new web

# Static server for one application: the library's two mounts, history fallback,
# watch and live reload. Plain Node, no dependencies of its own.
srl serve --app web --open

# --proxy forwards a prefix to a backend instead of serving it from disk, so an
# application whose session is a cookie its backend sets develops on one origin —
# the arrangement it is deployed into — rather than on two. Repeatable. Routes
# only: the prefix is not stripped, and status and headers pass through untouched.
srl serve --app web --proxy /api/=http://127.0.0.1:8001 --proxy /auth/=http://127.0.0.1:8001

# The application's inline import map against the library it installed: entries
# the library publishes and the map omits or hand-edited, prefixes resolving to
# a second copy of the framework, integrity hashes that no longer match their
# bytes. Every one of those is a blank page rather than a build error, so this is
# the check to put in CI. Prints the script-src hash a CSP has to allow.
srl check importmap

# Type-check every template against the same JSDoc types as the JavaScript,
# without compiling anything. Needs a tsconfig.json at the repository root.
srl check templates

# Either check with --json prints its findings as one document instead of a
# terminal report: a severity, a stable code, a message and the file, line and
# column, per finding. A check returns them as values and this is the second
# adapter over that — same findings, same exit code.
srl check templates --json

# The production artifact: minified, hash-named chunks, a production index.html
# whose import map pins a sha384 for every one of them, the compiled stylesheet,
# and dist/<app>/artifact.json describing what was emitted and what Cache-Control
# each file expects. Templates are minified too, one immutable file each, fetched
# by the component that names it; `--templates bundle` collapses them into the
# single JSON the manifest seeds from at startup instead.
srl build --app web

# Every element, global and template the project model can see.
srl model --app web --json
```

`srl --help` lists the rest: the release pipeline, the template bundle, the import-map
fragment, the mount table.

Each command is also a module, and still runs by path — the bin adds a name, not a layer.

```bash
node node_modules/@srljs/cli/delivery/build.mjs --app web
```

```js
import { buildArtifact } from '@srljs/cli/delivery/build.mjs';

const report = await buildArtifact({ app: { name: 'web', dir: '/abs/path/web' } });
```

The report is a named shape, not a bag: `ArtifactReport` in
`@srljs/cli/delivery/artifact-report.mjs`, which is also the only module that writes or
reads `artifact.json`. A tool of your own reads one through `readReport` and gets the
inventory, the chunk graph, the totals and the security metadata as typed properties, and
a malformed document is refused by field and file rather than accepted and half-used
(ADR-0074):

```js
import { readReport, isRemoteReport } from '@srljs/cli/delivery/artifact-report.mjs';

const { report } = await readReport('dist/web');
if (!isRemoteReport(report)) console.log(report.security.csp, report.totals.brotli);
```

## An origin for your own tests

`@srljs/core/testing/harness.js` renders a component and waits for it to settle; what it
needs is an origin serving your application the way your deployment does, so that
`/app.manifest.json`, the i18n bundles and every `@core/` specifier resolve in the browser
without a test-only branch in your source. That origin is
`@srljs/cli/origin/index.mjs`, and it is the same module `srl serve`, this repository's
benchmark and its production-artifact suite all serve through — the mount table, the
traversal refusal, the directory index, the history fallback and the MIME table
(ADR-0075).

```js
import { serveOrigin } from '@srljs/cli/origin/index.mjs';
import { MOUNTS } from '@srljs/cli/package/interface.mjs';

const appDir = '/abs/path/web';
const origin = await serveOrigin({
  mounts: [...MOUNTS, ['/', appDir]],
  fallback: `${appDir}/index.html`,
});

// origin.url is http://127.0.0.1:<ephemeral>; origin.close() when the suite ends.
```

Four options are what an adapter states: `route` for endpoints of your own — a fake
backend, an injected module — consulted before anything static; `transform` for a body to
send instead of the file's bytes; `headers` for a cache policy or a
`Content-Security-Policy`; and `fallback` for the document a navigation with no file gets.
There is deliberately no proxy option: `srl serve --proxy` is one adapter's `route`, not a
parameter every origin carries.

## Types

The library publishes the type checker's half of its interface too, and `srl new` writes a
`tsconfig.json` that extends it rather than copying four path mappings that would then be
free to drift from the import map:

```json
{
  "extends": "@srljs/core/tsconfig.base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["web/**/*.js"]
}
```

That is what makes `@core/` resolve for tsc, and what `srl check templates` reads. The
library ships no `.d.ts`: its types are JSDoc in the same `.js` files the browser runs, and
the base config is what lets tsc read them where they are installed. A second application
means one more `include` entry, which is the only edit this file needs per application.

## What the build expects of you

A scaffolded application satisfies all four already; this is what they are and why.

- **Tailwind, yours.** The build shells out to your own `node_modules/.bin/tailwindcss`,
  because the stylesheet it compiles is yours — written against your config and your
  version. Install `tailwindcss` and `@tailwindcss/cli` yourself; a copy pinned here would
  compile your CSS with a compiler you did not choose.
- **An import map in `index.html`.** It is the resolver: the build reads the application's
  own map and admits only the bare specifiers already declared there. A module importing
  something the map does not name fails the build rather than 404ing on one route.
- **A git repository.** The artifact records the commit it was built from.
- **At least two JavaScript chunks.** An application with nothing behind an `import()`
  carries every route in its entry, which is the shape the chunking exists to avoid.

## Release

The build is separate from the transport, and consumes only the verified report and bytes.

```bash
srl release --artifact dist/web --out staged --remote-root /srv/www/example.com
```

`srl verify-release` and `srl verify-http` check a staged tree and a live origin against the
report; `srl retention` prunes superseded releases.

## Dependencies

Three, pinned exactly and shipped as this package's own: **vite** 8.2.1 (MIT), **typescript**
6.0.3 (Apache-2.0) and **parse5** 6.0.1 (MIT).

## License

MIT. See [LICENSE](LICENSE).
