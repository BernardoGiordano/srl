# @srljs/cli

The toolchain for a repository built on
[**@srljs/core**](https://www.npmjs.com/package/@srljs/core). It holds a zero-config dev
server, the project model that static discovery reads, the template checker, the language
server, and the production build and release pipeline.

Nothing here is needed to *run* an srl application. A browser with an import map loads the
library as source and never runs a build. This package is for the repository that deploys
one, and it turns a directory with an `index.html` into minified, hash-named,
integrity-pinned chunks plus a report describing them.

Full documentation, the guides and the decision records are in
[the repository](https://github.com/BernardoGiordano/srl).

## Install

You need Node.js 22 or later, npm and Git. From a new repository:

```bash
git init
npm init -y
npm install --save-dev --save-exact @srljs/core@0.9.0 @srljs/cli@0.9.0 \
  tailwindcss@4.3.3 @tailwindcss/cli@4.3.3 @types/node@24.13.3
npx --no-install srl new web
npx --no-install srl check importmap
npx --no-install srl check templates
npx --no-install srl check messages
printf "node_modules/\ndist/\n" > .gitignore
git add .
git commit -m "Create web application"
npx --no-install srl build --app web
```

`npx --no-install` runs the repository's installed binary and cannot silently download a
different one.

`srl new` writes the smallest application that builds. That is the document with the
library's import map pasted and the vendored script hashed, an entry module and a lazy
chunk with their templates, the stylesheet, the manifest, a locale bundle, and a
`tsconfig.json` extending the published base. All nine files are interdependent, and each
is a contract the tools below enforce, so they come from one module. This toolchain's own
packaged-install probe drives that module through the journey above on every run. It
refuses rather than overwrites.

### Why those dependencies

| Dependency | Why you declare it |
|---|---|
| `tailwindcss`, `@tailwindcss/cli` | The build compiles *your* stylesheet against *your* config, so the CLI must not pin the version transitively |
| `@types/node` | The generated `tsconfig.json` names the Node type library |
| A Git commit | A build records the commit it was built from, so the repository needs one before the first build |

The install probe uses only these declared dependencies, and refuses an absent local
binary, type library, Tailwind or commit before a release can appear.

`@srljs/core` is a peer dependency pinned to the exact matching version. This package reads
the library's own manifest for the mounts and specifier prefixes and imports three of its
modules outright, so the two are one interface split across two tarballs.

It is published separately for one reason. The build needs Vite, parse5 and the TypeScript
compiler API, and the consumer this framework is actually for, a page with an import map
and no build step, must not have to install a bundler to load a library that never runs
one. `@srljs/core` keeps its two runtime dependencies.

## What a repository looks like

An application is any directory in your repository root with an `index.html`. Nothing is
configured, because the tools discover them.

```
your-repo/
  package.json
  web/               <- an application
    index.html
    app.manifest.json
    src/
  node_modules/@srljs/core/       served at /lib/ and /components/
```

Every tool takes `--app <dir>`, or `APP=<dir>`. With one application the flag is optional.
With two it is required, because a tool that picks one silently deploys the wrong thing
sooner or later.

The repository root is the working directory. Set `SRL_ROOT` only for the arrangement
neither default covers, such as a repository that vendors or submodules an srl checkout
somewhere below its own root.

## The tools

```bash
# A new application in the repository root. Refuses an existing directory; leaves an
# existing tsconfig.json alone and says which `include` entry to add.
npx --no-install srl new web

# Static server for one application. Serves the library's two mounts, history
# fallback, and live updates: an edited .html file is rendered into the components
# already showing it, a stylesheet is swapped, anything else reloads. Plain Node,
# no dependencies of its own.
npx --no-install srl serve --app web --open

# --proxy forwards a prefix to a backend instead of serving it from disk, so an
# application whose session is a cookie its backend sets develops on one origin,
# the arrangement it is deployed into. Repeatable. It routes only, so the prefix
# is not stripped and status and headers pass through untouched.
npx --no-install srl serve --app web --proxy /api/=http://127.0.0.1:8001 --proxy /auth/=http://127.0.0.1:8001

# The application's inline import map against the library it installed. Finds
# entries the library publishes that the map omits or hand-edits, prefixes
# resolving to a second copy of the framework, and integrity hashes that no
# longer match their bytes. Every one of those is a blank page rather than a
# build error, so this is the check to put in CI. Prints the script-src hash a
# CSP has to allow.
npx --no-install srl check importmap

# Type-check every template against the same JSDoc types as the JavaScript,
# without compiling anything. Needs a tsconfig.json at the repository root.
npx --no-install srl check templates

# Every message the source names, against the bundles the application registers.
# Finds a key no bundle answers, which renders as itself in every language, and
# a placeholder a call does not pass, which ships with a brace in the sentence.
# A key present in a translation and absent from the default locale fails too.
# --write adds the unanswered keys to the bundle that should hold them, each
# holding its key as its message, and leaves every existing line alone.
npx --no-install srl check messages
npx --no-install srl check messages --write

# Any check with --json prints its findings as one document instead of a
# terminal report, each with a severity, a stable code, a message, and a file,
# line and column. A check returns findings as values, and this is the second
# adapter over that. Same findings, same exit code.
npx --no-install srl check templates --json

# The production artifact. Minified, hash-named chunks, a production index.html
# whose import map pins a sha384 for every one of them, the compiled stylesheet,
# and dist/<app>/artifact.json describing what was emitted and what Cache-Control
# each file expects. Templates are minified too, one immutable file each, fetched
# by the component that names it. `--templates bundle` collapses them into the
# single JSON the manifest seeds from at startup instead.
npx --no-install srl build --app web

# Every element, global and template the project model can see.
npx --no-install srl model --app web --json

# The same model and template checker as an LSP server over stdio. Normally
# started by the VS Code or WebStorm plugin rather than by hand.
npx --no-install srl language-server
```

Editor installation and the complete feature list are in the repository's
[editor support guide](https://github.com/BernardoGiordano/srl/blob/main/docs/guide/editor-support.md).

`srl --help` lists the rest, including the release pipeline, the template bundle, the
import-map fragment and the mount table.

## Calling the tools directly

Each command is also a module and still runs by path. The bin adds a name, not a layer.

```bash
node node_modules/@srljs/cli/delivery/build.mjs --app web
```

```js
import { buildArtifact } from '@srljs/cli/delivery/build.mjs';

const report = await buildArtifact({ app: { name: 'web', dir: '/abs/path/web' } });
```

The report is a named shape. `ArtifactReport` lives in
`@srljs/cli/delivery/artifact-report.mjs`, which is also the only module that writes or
reads `artifact.json`. Your own tool reads one through `readReport` and gets the inventory,
the chunk graph, the totals and the security metadata as typed properties. A malformed
document is refused by field and file rather than accepted and half-used (ADR-0074).

```js
import { readReport, isRemoteReport } from '@srljs/cli/delivery/artifact-report.mjs';

const { report } = await readReport('dist/web');
if (!isRemoteReport(report)) console.log(report.security.csp, report.totals.brotli);
```

## An origin for your own tests

`@srljs/core/testing/harness.js` renders a component and waits for it to settle. What it
needs is an origin serving your application the way your deployment does, so that
`/app.manifest.json`, the i18n bundles and every `@core/` specifier resolve in the browser
without a test-only branch in your source.

That origin is `@srljs/cli/origin/index.mjs`. It is the same module `srl serve`, this
repository's benchmark and its production-artifact suite all serve through, carrying the
mount table, the traversal refusal, the directory index, the history fallback and the MIME
table (ADR-0075).

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

An adapter states four options.

- `route` handles endpoints of your own, such as a fake backend or an injected module. It
  is consulted before anything static.
- `transform` returns a body to send instead of the file's bytes.
- `headers` sets a cache policy or a `Content-Security-Policy`.
- `fallback` names the document a navigation with no file gets.

There is deliberately no proxy option. `srl serve --proxy` is one adapter's `route`, not a
parameter every origin carries.

## Types

The library publishes the type checker's half of its interface too, and `srl new` writes a
`tsconfig.json` that extends it rather than copying four path mappings that would then be
free to drift from the import map.

```json
{
  "extends": "@srljs/core/tsconfig.base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["web/**/*.js"]
}
```

That is what makes `@core/` resolve for tsc, and what `srl check templates` reads. The
library's types are JSDoc in the same `.js` files the browser runs, and the package ships a
declaration for each module emitted from that JSDoc. The base config resolves every prefix
to those declarations, so tsc never follows the library's JavaScript through `node_modules`
and a `strict` program reports nothing from inside the package. A second application means
one more `include` entry, which is the only edit this file needs per application.

## What the build expects of you

The setup at the top satisfies all four.

- **Tailwind, yours.** The build shells out to your own `node_modules/.bin/tailwindcss`,
  because the stylesheet it compiles is yours, written against your config and your
  version. A copy pinned inside the CLI would compile your CSS with a compiler you did not
  choose.
- **An import map in `index.html`.** It is the resolver. The build reads the application's
  own map and admits only the bare specifiers already declared there, so a module importing
  something the map does not name fails the build rather than 404ing on one route.
- **A Git commit.** The artifact records the commit it was built from.
- **At least two JavaScript chunks.** An application with nothing behind an `import()`
  carries every route in its entry, which is the shape the chunking exists to avoid.

## Release

The build is separate from the transport, and the transport consumes only the verified
report and bytes.

```bash
npx --no-install srl release --artifact dist/web --out staged --remote-root /srv/www/example.com
```

`srl verify-release` and `srl verify-http` check a staged tree and a live origin against
the report. `srl retention` prunes superseded releases.

## Dependencies

Three, pinned exactly and shipped as this package's own. They are **vite** 8.2.1 (MIT),
**typescript** 6.0.3 (Apache-2.0) and **parse5** 6.0.1 (MIT).

## License

MIT. See [LICENSE](LICENSE).
