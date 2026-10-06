# ADR-0124: One name reaches the core in both delivery shapes

- Status: accepted
- Date: 2026-10-06
- Affects: `source/package.json`, `source/lib/srl-core.js`, `source/lib/importmap.json`, `source/tsconfig.base.json`, `source/tsconfig.source.json`, `cli/package/entry.mjs`, `cli/package/interface.mjs`, `cli/project-model/parse.mjs`, `cli/project-model/index.mjs`, `cli/delivery/build.mjs`, `cli/scaffold/`, `tools/delivery/package-bundle.mjs`, `tools/checks/verify-deps.mjs`, `source/components/internal/`

## Context

A bundler reached the core as `@srljs/core`, 145 flat names behind `exports`. A browser
with an import map had no such name, so a small application imported about eleven deep
paths such as `@core/elements/component.js`. The READMEs showed both spellings side by
side. An application that mixed them through a bundler loaded the bundle and the deep
modules as two copies, with two element registries.

ADR-0066 gave each audience its own shape, and the review that proposed one name asked
for a measurement first, because an entry module loads every module behind it during
development. A throwaway application from `srl generate app` was measured both ways on
2026-10-06, on the local dev server in headless Chromium, median of ten loads.

| | Deep paths | Entry module |
|---|---|---|
| Scripts loaded in development | 30 | 50 |
| First render in development | 74 ms | 73 ms |
| Production payload, raw | 123.1 KB | 124.4 KB |
| Production payload, gzip | 42.9 KB | 41.5 KB |

The extra modules load in parallel, and the production build drops nearly all the
unused code, so the entry costs nothing measurable in development and about 1% of raw
bytes in production. The build keeps the top-level statements of the extra modules,
which is why the artifact report lists more library modules than before.

Two alternatives lost.

- Curating the bundle and fixing the READMEs alone keeps two spellings, and every guide
  has to pick one audience.
- An entry for the component bundle too would register every component on every page,
  because loading a component module defines its tag, and the build would keep all of
  them.

## Decision

**`srl.bundles.<name>.entry` names a source entry module.** The core bundle declares
`lib/srl-core.js`. `cli/package/entry.mjs` writes it from the same door as
`dist/srl-core.js`, so it re-exports the names the bundle exports from the modules the
deep paths load. `npm run importmap` writes it with the fragment, and `npm run verify`
fails when it is stale.

**The import map maps `@srljs/core` to the entry.** The published fragment carries it,
so `srl check importmap` asks every application for it. `@srljs/core` and a deep path
reach the same module instance.

**Every reader of the import map follows the entry.** `srl build` resolves
`@srljs/core` through the application's map to the entry, and never through `exports`.
The project model resolves each name imported from the entry to the module that
declares it, so `uses`, inheritance and message calls read the same under both
spellings. Both tsconfig tables map `@srljs/core`, the published one to the declaration
barrel over the same tree and the repository's one to the entry.

**The scaffold and the guides import the core as `@srljs/core`.** Deep paths stay
valid. Components keep their paths in an import map and `@srljs/core/components` in a
bundler.

**The component bundle offers `configureCollectionText`.** `components/internal/` is no
longer excluded from the component bundle. Its helpers are marked `@internal` instead,
and the one name the i18n guide asks applications to call is offered.

## Consequences

- An application written before this lacks `@srljs/core` in its import map, and
  `srl check importmap` reports `importmap/missing-specifier` until the fragment is
  pasted again.
- The example keeps its deep paths, which the entry does not change.
- Types declared in hand-written `types.d.ts` files are not in either barrel, so a type
  such as `RouteDef` is still imported from its deep path.
- Reopen this if the development cost grows with the library, or if a component entry
  becomes possible without registering every component.
