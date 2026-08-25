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
```

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
# Static server for one application: the library's two mounts, history fallback,
# watch and live reload. Plain Node, no dependencies of its own.
srl serve --app web --open

# The application's inline import map against the library it installed: entries
# the library publishes and the map omits or hand-edited, prefixes resolving to
# a second copy of the framework, integrity hashes that no longer match their
# bytes. Every one of those is a blank page rather than a build error, so this is
# the check to put in CI. Prints the script-src hash a CSP has to allow.
srl check importmap

# Type-check every template against the same JSDoc types as the JavaScript,
# without compiling anything. Needs a tsconfig.json at the repository root.
srl check templates

# The production artifact: minified, hash-named chunks, a production index.html
# whose import map pins a sha384 for every one of them, the compiled stylesheet,
# and dist/<app>/artifact.json describing what was emitted and what Cache-Control
# each file expects.
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

## Types

The library publishes the type checker's half of its interface too. Extend it rather than
copying four path mappings that would then be free to drift from the import map:

```json
{
  "extends": "@srljs/core/tsconfig.base.json",
  "include": ["web/**/*.js"]
}
```

That is what makes `@core/` resolve for tsc, and what `srl check templates` reads. The
library ships no `.d.ts`: its types are JSDoc in the same `.js` files the browser runs, and
the base config is what lets tsc read them where they are installed.

## What the build expects of you

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
