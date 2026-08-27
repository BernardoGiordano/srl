# ADR-0077: A module declares which of its exports are the door

- Status: accepted
- Date: 2026-08-27
- Affects: `cli/package/door.mjs`, `tools/delivery/package-bundle.mjs`, `source/lib/core/template/dialect.js`

## Context

[ADR-0066](0066-the-registry-consumer-gets-bundles.md) gave the registry consumer bundles,
and [ADR-0033](0033-the-library-publishes-its-own-interface.md) is why the bundle is a
barrel the build walks rather than a list somebody maintains: a layer added once has to
reach every consumer, and an export list is a second place to forget a name.

The barrel was `export * from` each member, so it published every top-level export in
`lib/`. A module exports a name for two different reasons, though. `defineComponent` is
exported because an application calls it. `compileTemplate` is exported because a suite
does — its own comment says "Exported for tests; application code goes through
`loadTemplate`". `resetInjector` says "For test isolation". The fifteen names in
`dialect.js` are exported because `cli/checks/template-check.mjs` implements the same
grammar in Node and the two must not drift; an application author binds templates, never
calls `classifyBindingTarget`.

So `import { … } from '@srljs/core'` autocompleted to 144 names in one flat namespace.
The example application uses five modules at any frequency. Every one of the other 139
names reads as a promise the library did not mean to make, and the ones the source itself
documents as internal are promises it explicitly did not mean to make.

A hand-written export list was rejected, and stays rejected. It is the thing ADR-0033
exists to prevent: the registry consumer would be the one audience a new layer did not
reach until someone remembered to add it, which is exactly the drift the derived barrel
was built to end. Excluding whole directories, the way `srl.bundles.exclude` already
excludes `components/internal`, does not fit either — `dialect.js` sits beside the
template runtime that needs it, and `compileTemplate` sits in that runtime.

## Decision

The barrel stays derived, and gains one input: a module marks an export `@internal` and
that name leaves the door.

The marker is per name and lives beside the declaration, in the doc comment that already
explains why the export exists. `@internal` is TypeScript's own tag, so it means the same
thing to an editor as it does here. It is read from the doc comment written *directly*
above the declaration: TypeScript attaches every preceding block to a statement, so
without the adjacency rule a module header that used the word would mark its first export
and silently nothing else.

`@internal` is not `private`, and marks nothing unreachable:

- the browser consumer loads modules by path through the import map and sees every export
  it always did;
- `cli/checks/template-check.mjs` still imports the dialect from
  `@srljs/core/lib/core/template/dialect.js`, which is the seam ADR-0066 left open;
- inside a bundle, members resolve each other by file rather than through the barrel, so
  nothing in the library changes shape.

The curated surface is the bundle's flat namespace, because that is the only place a name
reads as an offer.

`cli/package/door.mjs` owns the rule. It parses one module's text and returns the names it
exports and the subset it keeps back — no disk, no manifest, no resolution — so the rule
tests against a string. It also emits the entry module: `export *` for a member that keeps
nothing back, a named list for one that does, and a bare `import` for one that keeps
everything, because a member is in the bundle for a reason and dropping its statement
would drop its side effects.

## Consequences

`@srljs/core` offers 123 names instead of 144. The twenty-one that left are the fifteen of
the template dialect, `compileTemplate`, `resetInjector`, `captureContent`,
`projectContent`, `preferenceKey` and `migrateLegacyKey`.

`export *` survives where nothing is marked, which is most modules, and that matters: two
members exporting the same name is a build error under `export *` rather than a silently
missing export. The one apparent collision — `parseExpression` in both `expression.js` and
`expression-parser.js` — is a re-export of one binding, which `export *` resolves to
itself.

Four module shapes are now build errors rather than a quietly wrong door: `export *`,
`export * as`, a default export, and a destructuring export. None exist in the library, and
each would make the barrel narrow a module it could not read.

The failure the marker introduces is cross-bundle. A name marked in `lib/` is invisible to
a component that imports it, because inside `srl-components` that import resolves to
`./srl-core.js`. The build refuses a bundle whose sibling no longer offers a name it
imports, checked against both emitted files rather than against the door tables, and
`tools/test/package-bundle.test.mjs` asserts the same property. Nothing else would catch
it: the browser suites resolve that import through the import map, where every export is
still reachable.

Marking is a judgement, and this record does not make it for future names. The test that
was applied here was the module's own comment — a name whose doc says it exists for a
suite or for the checker — plus `dialect.js`, whose header already declares it a grammar
shared by two implementations rather than an application surface. Names that merely have
no caller outside a suite today were left alone: `min`, `notAfter` and
`bypassSecurityTrustHtml` are the door whether or not this repository's own screens have
reached for them yet.

What reopens this: a consumer who needs one of the twenty-one through a bundler. The
answer then is to unmark that name, not to publish the raw tree — the marker is a
statement about the door, and unmarking is a one-line diff in the module that made it.
