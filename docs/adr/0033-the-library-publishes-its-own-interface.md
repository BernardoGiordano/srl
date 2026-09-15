# ADR-0033: The library publishes its own interface

- Status: accepted
- Date: 2026-08-12
- Affects: `source/package.json`, `cli/package/interface.mjs`, `cli/layout.mjs`

## Context

Two kinds of fact once shared `cli/layout.mjs`. Some belonged to the package, such as the `/lib/` and `/components/` mounts, the `@core/` prefix and `lit` living in `lib/vendor`. Others belonged to this repository, such as the package sitting at `source/` and applications being root directories with an `index.html`.

With both in one table, the library's interface existed only because several tools agreed on it. The same mounts were restated in import maps, tsconfig paths, the test runner, the dev server and the delivery tools.

## Decision

`source/package.json` declares the package's surface: the browser mounts, the bare specifier prefixes and the vendored runtime dependencies. `cli/package/interface.mjs` is the only module that reads it, and every other tool asks that module.

`cli/layout.mjs` keeps only repository facts, namely where the package sits and which directories are applications.

`npm run verify` fails when the four descriptions of the interface disagree. Those are the manifest, the generated import map fragment, the `exports` map and the tsconfig paths.

## Consequences

- Extracting the library is a file move.
- A layout change touches one declaration.
- Both modules read their manifest synchronously and have no dependencies, so they work before `npm install`.
