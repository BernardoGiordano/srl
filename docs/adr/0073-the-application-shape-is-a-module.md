# ADR-0073: The application shape is a module, and `srl new` is one of its two adapters

- Status: accepted
- Date: 2026-08-26
- Affects: `cli/scaffold/application.mjs`, `cli/bin/srl.mjs`, `tools/checks/pack-check.mjs`, `cli/README.md`

## Context

An srl application is nine interdependent files, and every one of them is a contract this
toolchain enforces after the fact.

The document must carry exactly one of each of the eight facts the production HTML
transform requires ([ADR-0041](0041-production-html-is-a-transform-not-an-edit.md)) or the
build refuses it. Its inline import map must carry the library's published fragment entry
for entry and hash for hash, because the map is the resolver and a hand-edited one is a
blank page — which is why `srl check importmap` exists at all
([ADR-0068](0068-the-installed-shape-is-checked-by-installing.md)). The vendored Tailwind
script is a classic script, so its `sha384` is an attribute rather than an integrity-map
entry. There must be at least two JavaScript chunks, because an application with nothing
behind an `import()` carries every route in its entry. The manifest must satisfy the
library's own admission policy, whole
([ADR-0010](0010-manifest-admission-is-one-whole-document-decision.md)). The stylesheet
reaches into the installed package by `node_modules` path, where a mistake is a Tailwind
resolve error and nothing the build would otherwise catch. And `tsconfig.json` must extend
the published base, or `@core/` resolves for the browser and not for tsc.

That shape was written down correctly, executably, and in the one place no consumer could
reach: `writeApplication()` inside `tools/checks/pack-check.mjs`. A hundred and eighty
lines, zero exports, reachable by `npm run pack:check` and by nothing else. `tools/` is
published nowhere ([ADR-0067](0067-the-toolchain-is-a-second-package.md)), so an adopter
re-derived the same nine files from prose in `cli/README.md` and from `example/`, which is
a 114-file application and not an answer to "what is the minimum".

ADR-0068 named the cost when it accepted that fixture: it is "a fifth description of what
an `index.html` has to contain", and "one more place to edit". The reverse was worse. The
fixture and the instructions could disagree, and the only thing that would notice was a
consumer's first afternoon.

## Decision

**The shape is a module**, `cli/scaffold/application.mjs`, in the package a consumer
installs. It has two halves.

`applicationFiles(facts)` is pure: path to contents, nothing touching disk. What a
scaffolded document contains is therefore assertable without a temp directory, a tarball
or a subprocess, and `cli/test/scaffold.test.mjs` asserts the eight facts appear once each
rather than asserting that a build succeeded.

`emitApplication(root, { name })` is the adapter that finds the facts and writes. Every
fact that depends on where the library is installed is found, never typed: the import map
is the fragment the library ships, read from `IMPORT_MAP_FILE`; the integrity hash is
computed from the bytes in the package; the mount URLs and the `node_modules` path to the
collection stylesheets are derived from the library's own manifest through
`cli/package/interface.mjs` ([ADR-0033](0033-the-library-publishes-its-own-interface.md)).
Nothing written into a scaffolded application can go stale against the library it was
scaffolded from.

**Two adapters cross it the day it lands.** `srl new <name>` is the consumer's, and the
packaged-install probe is this repository's: `pack-check.mjs` no longer writes a fixture,
it runs `srl new app` through the published bin. So the thing an adopter is given is the
thing `npm run check` drives end to end — import-map check, template checker, build,
artifact assertions — every run.

The probe goes through the bin rather than importing the module, and that is load-bearing.
Imported here, the scaffold would find the library beside `cli/` in this checkout and paste
*that* import map, which is the one thing the probe exists to avoid. Run inside the probe,
it resolves the installed package and the fixture is made of the bytes under test.

**It refuses rather than overwrites.** An existing application directory is refused whole:
a scaffold that merged into one would leave a repository in a shape neither the command nor
its author described. `tsconfig.json` is the exception, because a repository adding its
second application already has one and it is theirs — it is reported, with the `include`
entry to add, and left alone. A name must be one lowercase kebab-case segment, and must not
be a directory `cli/layout.mjs` never reads as an application, because writing an
application into `dist/` produces one nothing will ever build.

Findings are `Diagnostic[]` like every other command's, so `srl new --json` costs this
module nothing ([ADR-0072](0072-a-check-returns-diagnostics.md)).

## Consequences

The first hour stops being assembly. `npm install --save-dev @srljs/cli && srl new web`
produces a repository that builds, and the prose in `cli/README.md` that used to describe
the same nine files by hand is now one command plus the explanation of what the build
expects of you.

Scaffold and check cannot drift, which is the property the old arrangement could not have.
A change to the eight-fact HTML contract, to the manifest policy, or to the published
tsconfig base now breaks one module, and it breaks it inside `npm run check` rather than in
a consumer's first afternoon. ADR-0068's "one more place to edit" is closed: the place is
the module, and the probe is a caller.

The emitted application is deliberately the smallest thing that runs — a component, a
template, a signal and a lazy chunk — not the shape a real application takes. An
application with routes, a manifest-driven startup and a session replaces `main.js` with
one call to `startHostedApplication` and keeps every other file as written. That is a
choice worth naming: a scaffold that emitted the hosted-runtime shape would be a second,
larger fixture for the probe to drive, and the probe's subject is the packaging seam rather
than the router. `example/` remains the answer to "what does a real one look like".

`srl new` is now the toolchain's first write command. Every other one reads the repository
and writes into `dist/` or a staging tree; this one writes source files a person then owns.
The refusals above are what keeps that safe, and they are the reason the command has no
`--force`: a flag that overwrote an application directory would be the one irreversible
thing in this package.
