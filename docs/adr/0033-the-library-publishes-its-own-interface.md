# ADR-0033: The library publishes its own interface; the repository keeps only repository facts

- Status: accepted
- Date: 2026-08-12
- Affects: `source/package.json`, `tools/package/interface.mjs`, `tools/layout.mjs`

## Context

Two unrelated facts used to share one module, `tools/layout.mjs`:

- **the package's** — `/lib/` and `/components/` are where the library is served, `@core/`
  resolves into it, `lit` comes from `lib/vendor`;
- **the repository's** — the package sits at `source/`, and any root directory with an
  `index.html` is an application.

Only the second is true of this repository in particular. While both lived in one table,
the library's interface existed only because five modules under `tools/` agreed on it: a
consumer outside this repository had nothing to import, and the same three mounts were
restated in the inline import maps, the tsconfig paths, the test-runner config, the dev
server and the delivery tooling.

## Decision

`source/` is the package and declares its own surface in `source/package.json`: the mounts
a browser sees, the bare specifier prefixes the source is written against, and the vendored
runtime dependencies. `tools/package/interface.mjs` is the only module that reads that
manifest, and everything else — the dev server, the test-runner origin, the benchmark
origin, the verifier, the build, the deployment — asks it rather than restating the table.

`tools/layout.mjs` keeps what a standalone checkout would not have: where the package
happens to sit inside this repository, and which directories are applications.

`npm run verify` fails when the four descriptions of the published interface disagree —
the manifest, the generated import-map fragment, the `exports` map and the tsconfig paths.
Nothing at runtime notices otherwise: the browser follows the map, `tsc` follows the paths,
npm follows `exports`, and each resolves a different set of files.

## Consequences

Extracting the library becomes a file move: `source/` becomes the root of a standalone
checkout, and the manifest is found one directory up instead of two.

A layout change is one generated file rather than fourteen modules, and the interface has
one authority rather than four opinions.

Both modules stay dependency-free and read their manifest synchronously at load, so they
work before `npm install` like the rest of `tools/`.
