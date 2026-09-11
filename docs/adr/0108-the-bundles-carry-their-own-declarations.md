# ADR-0108: The bundles carry their own declarations

- Status: accepted
- Date: 2026-09-10
- Affects: `source/package.json`, `tools/delivery/package-bundle.mjs`, `cli/package/door.mjs`, `cli/package/interface.mjs`, `tools/checks/verify-deps.mjs`, `tools/checks/pack-check.mjs`, `tools/test/package-bundle.test.mjs`

## Context

[ADR-0066](0066-the-registry-consumer-gets-bundles.md) gave the second audience — Node or
a bundler, no import map — pre-resolved bundles, and deferred their types. The reason it
gave was real: every module in `lib/` is written against `@core/` and friends, so a
declaration emitted from one names prefixes the consumer's resolver has never heard of,
and the resolution problem the bundles solved for JavaScript came back unsolved for the
type layer.

The deferral had a cost that only that audience pays. A consumer who installed
`@srljs/core` and wrote `import { defineComponent } from '@srljs/core'` got a value of
type `any`: no signature, no completion, no error on a misspelled spec key. The library's
types exist — they are JSDoc in the `.js` files the browser runs, and
`tsconfig.base.json` publishes the table that resolves them — but that table maps
`@core/*` to files under `lib/`, which is the source path. A bundler consumer loads
`dist/`, and nothing pointed from one to the other.

No condition in `exports` could have fixed that. TypeScript takes the `.d.ts` beside a
`.js` target it has already resolved, so the gap was the absent file rather than the
absent condition — but a map that names the declaration keeps naming it when the two stop
being siblings, and a resolver that does not do the substitution needs to be told.

## Decision

Each bundle ships a declaration beside it, and `exports` names it.

`npm run package` emits one declaration per module into `dist/types/`, mirroring the
package's own layout, using the compiler options `tsconfig.base.json` already publishes —
so the bundled declarations describe the same modules under the same `lib`, `target` and
`paths` a source consumer type-checks them under. Every library prefix in the emitted
declarations is then rewritten to a relative path. That rewrite is arithmetic rather than
a second resolution: the tree mirrors the source, so the step from one file to another is
the same in both and can be computed from the source paths.

Each bundle then gets a barrel over its own members' declarations, `dist/srl-core.d.ts`
and `dist/srl-components.d.ts`, and the subpath becomes conditional —
`{ "types": …, "default": … }`, in that order, because conditions are matched in order.
The barrel is derived from the same `ModuleDoor` the JavaScript barrel is derived from,
so a name marked `@internal` leaves both surfaces at once and the two cannot describe
different libraries. The minified declaration forwards to the readable one, because
minification changes bytes a browser runs and nothing a type checker reads.

The declarations are not rolled up into a single file. A rollup has to rename every
colliding local type and reproduce tsc's own emit rules to do it, and it buys nothing a
consumer can see: a resolver reads the barrel, and the tree behind it is the same set of
facts the browser consumer already gets from the JSDoc.

One rewrite is not about the prefixes. TypeScript writes an inferred type as
`import('…').Thing` naming the module that *declares* it, which for `nothing` is
`lit-html` rather than the `lit` the source imported — a package this one does not
depend on, and one that resolves only where a flat `node_modules` happens to hoist it.
A declaring module is rewritten to the dependency that re-exports it, and the build
refuses any declaration that still names a package outside `dependencies`.

## Consequences

`@srljs/core` is typed for both audiences from one set of JSDoc. The source consumer
still extends `tsconfig.base.json` and resolves `@core/*` into `lib/`; the bundled
consumer resolves through `exports` and needs no configuration at all.

`dist/` is bigger — the tree is one declaration per module — and it is still generated,
still uncommitted, and still built by `npm run check`. `npm run package --check` now
fails when a declaration is missing as well as when a bundle is.

Two checks stand behind the claim. `tools/test/package-bundle.test.mjs` type-checks the
emitted barrels with `skipLibCheck` off and no `paths`, and asks the checker — not the
text — which names they offer, so a declaration that still named a prefix, or a tree
missing a file it imports, fails there. `tools/checks/pack-check.mjs` installs the
tarballs and typechecks a consumer whose tsconfig extends nothing and aliases nothing;
its two `@ts-expect-error` directives fail the run if a name resolves to `any`, which is
what an absent declaration looks like from the outside.

What this does not do is type the raw trees for a bundler. `./testing/harness.js` still
resolves to source that names `@core/`, and it was already unusable for that audience.
Its consumers are the browser suites, which resolve it through the import map.
