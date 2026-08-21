# ADR-0066: The registry consumer gets bundles; the browser consumer still gets source

- Status: accepted
- Date: 2026-08-21
- Affects: `source/package.json`, `tools/delivery/package-bundle.mjs`, `tools/package/interface.mjs`, `tools/checks/verify-deps.mjs`

## Context

[ADR-0033](0033-the-library-publishes-its-own-interface.md) gave the package one manifest
declaring what it publishes, and derived an `exports` map from the specifier prefixes the
source is written against. That map said things like `"./core/*": "./lib/core/*"`, and it
was wrong in a way nothing here could see.

Every module under `lib/` imports `@core/`, `@auth/`, `@host/`. Those prefixes are
resolved by the import map the package publishes, which is a browser mechanism. Node's
resolver and every bundler's resolver ignore it — a package can declare `imports`, but
Node requires those keys to start with `#`, so there is no declaration that would make
`@core/` resolve for an installed package. A consumer who ran `npm install` and wrote
`import { defineComponent } from '@srljs/core/core/elements/component.js'` got a module that
threw on *its* first import, one level down, with a specifier they had never typed.

So `exports` advertised a surface that did not work, and the check that kept it in step
with the import map was keeping two descriptions of one interface consistent while one of
them was unusable. The alternative considered first was to write the source against
relative paths and drop the prefixes; that ends the buildless story, because a browser
loading `../foundation/reactive.js` from thirty modules is thirty requests the import map
was flattening, and the prefixes are also what makes a remote's shared-dependency list
readable. The prefixes are not the problem. The absence of a resolver for the second
audience is.

## Decision

The package publishes both shapes, and says which is which.

The browser consumer is unchanged and is still the point: `lib/` and `components/` ship as
source, `lib/importmap.json` ships beside them, and an application that pastes the
fragment gets the library's own bytes with no build step.

The registry consumer gets pre-resolved bundles. `npm run package` emits four files into
`source/dist/` — `srl-core.js`, `srl-core.min.js`, `srl-components.js`,
`srl-components.min.js` — in which every internal prefix has been resolved at build time,
so the emitted file imports nothing but `lit` and `@preact/signals-core`. Those two are
declared as `dependencies`, pinned to the versions `lib/vendor` holds, and `exports` names
the bundles rather than the raw trees.

`srl-components.js` treats the framework as external and imports `./srl-core.js`; the
minified file imports the minified one. Inlining core into both would put two custom
element registries, two injectors and two template caches in one page, and the second
`defineComponent` for a tag would throw against a registry the first one filled. This is
correctness, not size.

Which modules a bundle is a barrel over is declared in the manifest, as `srl.bundles`,
next to the table it is derived from: an entry claims specifier *prefixes*, not
directories, and `npm run verify` fails unless every prefix in `srl.imports` is claimed by
exactly one bundle. That is what keeps ADR-0033's guarantee — a layer added once reaches
every consumer — true for the second audience as well as the first.

Component templates are inlined. `defineComponent` derives a template from
`import.meta.url`, and inside a bundle every module shares one, so the derivation would
collapse fifteen components onto one file name. The build gives each declaration an
explicit `template` path and seeds the compiler with that file's bytes under
`new URL(path, import.meta.url).href` — the same expression the runtime evaluates, from
the same literal, so the seeded key and the looked-up key cannot drift. Nothing about
compilation changes: `seedTemplates` was always a seed rather than a replacement, so the
bundled page runs the same compiler over the same bytes as the buildless one.

## Consequences

`source/dist/` is generated and not committed, like an application's `app.css`. It is
built by `npm run check`, and `npm run verify` fails with the command to run when
`exports` names a file that is not there, so a release cannot ship a map pointing outside
its own tarball.

The raw trees are no longer in `exports`. They still ship, and the import-map consumer
still loads them by path, but a bundler is no longer offered a subpath that throws.

Types are not published for the bundles. The sources carry JSDoc written against the same
prefixes, so a rolled-up `.d.ts` needs the same resolution problem solved again for the
type layer; until it is, the bundles are JavaScript and the typed path is the buildless
one, through the root `tsconfig` paths. Reopening this needs a consumer who wants
`@srljs/core` typed through a bundler.

What the bundles are checked by is `tools/test/package-bundle.test.mjs`, which builds them
and reads the emitted bytes: the specifiers each file imports, that a minified bundle
extends a minified one, and that every declared template path has a seeded source under
it. It does not execute them. The browser suites run the library from source through an
import map, which is exactly the resolution a registry consumer does not have, so nothing
here proves a bundled page renders — closing that needs a suite whose page loads `dist/`,
and therefore a build step before `npm test` rather than inside `npm run check`.

A third audience — a CDN consumer loading `https://unpkg.com/@srljs/core/dist/srl-core.js` —
now works by accident of the same bundles, but nothing here is designed for it and no
check covers it.
