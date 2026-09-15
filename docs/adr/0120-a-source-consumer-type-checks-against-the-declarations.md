# ADR-0120: A source consumer type-checks against the declarations

- Status: accepted
- Date: 2026-09-15
- Affects: `source/tsconfig.base.json`, `source/tsconfig.source.json`, `tsconfig.json`, `cli/package/interface.mjs`, `tools/delivery/package-bundle.mjs`, `tools/checks/verify-deps.mjs`, `tools/checks/pack-check.mjs`

## Context

[ADR-0068](0068-the-installed-shape-is-checked-by-installing.md) published
`tsconfig.base.json` with `paths` into `lib/` and `maxNodeModuleJsDepth: 1`, so a consumer's
tsc read the library's JSDoc where it was installed. It also named the condition for
reopening that. If the depth ever caused trouble, the base would stop relying on it and the
library would publish declarations.

It caused trouble. tsc counts each import from one `.js` file under `node_modules` to the
next against the depth, and treats a module past it as untyped. The library's modules
import each other several levels deep, so a consumer with `strict` on got TS7016 reported
inside `node_modules/@srljs/core`. `session.js` could not type `@core/foundation/json.js`,
`runtime.js` could not type `mount.js` or `template.js`, and `harness.js` could not type
`settled.js`, which also made every harness call `any` to type-aware lint. An application
on 0.9.0 filtered `node_modules` out of its typecheck script to get a clean run.

Raising the depth was measured against that application and rejected. At 2, seven errors
remained inside the library. At 3, TypeScript 6 cleared the library's TS7016 errors, but
tsgo 7 had pulled in `punycode/punycode.js` from depth 2 onward and reported 22 errors in
it under the consumer's `strict`. `@types/node` names that module, and a userland copy
hoisted by an unrelated dependency satisfies it. The depth a consumer needs depends on what
it imports, and every other package's JavaScript enters at the same depth, so no value is
right for everyone.

[ADR-0108](0108-the-bundles-carry-their-own-declarations.md) had meanwhile emitted one
declaration per module into `dist/types/` for the bundled audience. Declarations do not
count against the depth.

A fallback table, `lib/` first and `dist/types/` second, was tried too. tsc takes the first
candidate that resolves to any file, so the `.js` in `lib/` wins and the fallback is never
reached.

## Decision

The published base maps every prefix into the declaration tree, `"@core/*":
["./dist/types/lib/core/*"]` and the same for the other three. The browser still loads
`lib/` through the import map. The tree describes those modules, emitted from their JSDoc
under the base's own options. `maxNodeModuleJsDepth` stays at 1 for the subpaths `exports`
names as JavaScript, the test harness among them, and their own prefix imports land on
declarations.

This repository cannot use that table. It edits the modules the tree is built from, and a
table pointing at `dist/types/` would check it against whatever the last `npm run package`
wrote, or against nothing in a fresh clone. `source/tsconfig.source.json` extends the base,
restores the `lib/` table and sets nothing else. The root `tsconfig.json` extends it, and
the declaration emit reads it. It is not published.

`verify-deps.mjs` checks both tables against the import map, refuses anything but `paths`
in the source table, and requires the root to extend it. `pack-check.mjs` installs the
tarballs and typechecks a strict consumer that imports every module under every prefix plus
the harness, with `@types/node` loaded and `skipLibCheck` off, and refuses any diagnostic.
That consumer puts every module a single import away, where no depth elides anything, so a
clean typecheck passes even with the prefixes resolving into `lib/`. The check therefore also
lists the program's files and refuses any of the library's JavaScript besides the harness.

## Consequences

A strict consumer's full program reports nothing from inside `@srljs/core` under TypeScript
6 or tsgo 7, with no output filtering and no depth override.

The repository no longer type-checks through the exact file it publishes. The two differ in
`paths` alone, `verify-deps.mjs` holds them to that, and the pack check proves the published
arrangement by installing it.

Go-to-definition in a consumer's editor lands in a `.d.ts` rather than the `.js` the browser
runs, because the emit writes no declaration maps. Emitting them would lead a consumer back
to the source.

A tarball without `dist/types/` leaves a consumer with no library types at all. The pack
check's strict consumer fails on that, and `npm run check` runs it.

This reopens if a consumer needs types for a subpath the tree does not cover. The answer then
is a declaration for that subpath, not a deeper depth.
