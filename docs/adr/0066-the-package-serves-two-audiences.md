# ADR-0066: The package serves two audiences

- Status: accepted
- Date: 2026-09-15
- Affects: `source/package.json`, `source/tsconfig.base.json`, `source/tsconfig.source.json`, `tools/delivery/package-bundle.mjs`, `cli/package/door.mjs`, `cli/package/interface.mjs`, `tools/checks/verify-deps.mjs`, `tools/checks/pack-check.mjs`

## Context

Every module under `lib/` imports through prefixes such as `@core/` and `@auth/`, and the import map resolves them in a browser. Node and bundlers ignore import maps, and Node's `imports` field only accepts keys that start with `#`. An `exports` map pointing into `lib/` offered subpaths that threw on their first internal import.

Rewriting the source to relative paths would give up the prefixes, which also keep a remote's list of shared dependencies readable.

Types had the same problem one layer down. A consumer's `tsc` that follows JSDoc through `node_modules` is limited by `maxNodeModuleJsDepth`. At depth 1 a strict consumer saw TS7016 errors from inside the library. Deeper settings pulled in other packages' JavaScript, and no single depth worked for everyone.

## Decision

The package publishes two shapes.

| Audience | Gets |
|---|---|
| Browser with an import map | `lib/` and `components/` as source, plus `lib/importmap.json` |
| Node or a bundler | Pre-resolved bundles in `dist/` |

`npm run package` emits `srl-core.js`, `srl-components.js` and a minified version of each. The build resolves every internal prefix, so a bundle imports only `lit` and `@preact/signals-core`. `srl-components.js` imports `srl-core.js` instead of inlining it, so a page has one element registry, one injector and one template cache. Component templates are inlined by giving each declaration an explicit `template` path and seeding the compiler with that file's bytes.

`srl.bundles` in the manifest lists the prefixes each bundle covers. `npm run verify` fails unless every prefix belongs to exactly one bundle.

A module keeps an export out of a bundle's flat namespace by marking it `@internal` in the doc comment directly above the declaration, and `cli/package/door.mjs` reads that marker. Internal names stay reachable by path through the import map.

Types come from one declaration tree in `dist/types/`, emitted from the JSDoc. Each bundle has a barrel declaration beside it, and `exports` lists `types` before `default`. The published `tsconfig.base.json` maps every prefix into `dist/types/`, so a source consumer also type-checks against declarations and no depth setting is involved. This repository edits the modules the tree is built from, so it uses `source/tsconfig.source.json`, which differs from the base only in `paths`.

## Consequences

- `dist/` is generated and not committed. `npm run verify` fails if `exports` names a missing file.
- A bundler consumer gets typed imports with no configuration.
- A strict consumer's program reports nothing from inside `@srljs/core`, and `pack-check.mjs` proves it by installing the tarballs.
- Go-to-definition in a consumer's editor lands in a `.d.ts`, because no declaration maps are emitted.
- The browser suites run from source, so nothing here proves that a bundled page renders.
- A consumer who needs an `@internal` name through a bundler gets it when that name is unmarked.
