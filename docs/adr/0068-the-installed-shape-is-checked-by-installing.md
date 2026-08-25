# ADR-0068: The installed shape is checked by installing, and the type table ships with the library

- Status: accepted
- Date: 2026-08-25
- Affects: `tools/checks/pack-check.mjs`, `source/tsconfig.base.json`, `cli/bin/srl.mjs`, `cli/checks/importmap-check.mjs`, `tools/checks/verify-deps.mjs`

## Context

[ADR-0067](0067-the-toolchain-is-a-second-package.md) split the toolchain into
`@srljs/cli` and left three things unfinished, all of them the same thing: the arrangement
a consumer has is not the arrangement this repository runs, and nothing here could tell.

That was not hypothetical when it was written. Splitting the packages broke the build,
because the import-map resolver skipped every importer under `node_modules` — right while
the library was a sibling directory, wrong the moment it was installed. It was found by
packing both tarballs into a scratch directory and building, by hand.

Three more gaps had the same root.

**The type table was a copy.** The four `paths` mappings that make `@core/` resolve for tsc
lived in this repository's `tsconfig.json`. A consumer had to write their own, which is a
second table nothing compares to the import map — exactly what
[ADR-0033](0033-the-library-publishes-its-own-interface.md) removed for the browser and
left standing for the type checker. `srl check templates` in a consumer read a
`tsconfig.json` that may not exist, and reported its absence as one TypeScript diagnostic
per template, counted in "N template type error(s)". A repository with no tsconfig was told
its templates had type errors.

**The import-map drift check was not shippable.** The one thing that catches a hand-edited
map or a stale integrity hash — a blank page in both cases — was a slice of
`verify-deps.mjs`, which also checks this repository's layering, its translations and its
own vendored bytes. A consumer could not run it, and
[santella.dev](https://santella.dev) had written its own 78-line version.

**Every tool was a path.** `node node_modules/@srljs/cli/delivery/build.mjs --app web` is
what a package.json script had to say.

## Decision

**The type table ships with the library**, as `source/tsconfig.base.json`, exported as
`@srljs/core/tsconfig.base.json`. It carries the four `paths`, `allowJs`/`checkJs`,
`noEmit`, and the module and target settings the library's own source is written against.
Path targets in an extended config resolve against the file that declares them, so the
mappings point into the package wherever it was installed and need no editing per
consumer.

This repository extends the same file, and `verify-deps.mjs` fails if its `tsconfig.json`
stops extending it or grows a `paths` block of its own — `paths` replaces rather than
merges, so a local copy would be free to drift, which is the thing being ended.

The base also sets `maxNodeModuleJsDepth: 1`. This is not a style preference. The package
publishes no `.d.ts` (ADR-0066): the types are JSDoc in the `.js` files the browser runs,
which is what makes one set of bytes both the runtime and the contract. tsc will not read
inside a `.js` file under `node_modules` unless told to, so without that line every
`@core/` import in a consumer's application is `any` and every one is reported as TS7016.
The cost is that other installed packages' top-level JavaScript enters the program; the
alternative is a typed buildless library that is typed only in its own repository.

The template checker now checks only the templates the repository owns. It still reads the
library's, and has to: a template naming `<ui-table>` is checkable only against the element
`ui-table` declares. What it does not do is *report* on them when they came from a package,
because they were checked in that package's own repository and tsc cannot read their JSDoc
where they now sit. The count of what was skipped is printed, because a check that quietly
covers less than it appears to is worse than one that covers less.

**The drift check is a tool**, `cli/checks/importmap-check.mjs`, run as
`srl check importmap`. It checks what a consumer needs checked and nothing that is this
repository's business: that the map carries the library's published fragment entry for
entry and hash for hash, that the library's prefixes resolve into the installed package
rather than a second copy, that every integrity hash matches the bytes it covers, and that
every mapped URL answers. It prints the `script-src` hash the map needs, because a CSP that
omits it is a blank page whose only symptom is a module-resolution error.

**One bin**, `srl`, dispatching to modules that each still run by path. It rewrites
`process.argv` and imports the target rather than spawning: one process, and an error keeps
the stack of the tool that threw. Every tool already parses its own arguments and owns its
own exit code, so the bin adds a name and not a layer.

**And the installed shape is checked by installing it.** `npm run pack:check` packs both
workspaces, extracts them into `node_modules/@srljs/` as real directories, symlinks the
rest of this repository's dependencies, writes the smallest application that exercises the
seam, and drives the import-map check, the template checker and the build through the
published bin. It asserts the artifact's modules come from the installed package. It is
part of `npm run check`.

Two details in it are load-bearing. The `@srljs` directories are extracted, never
symlinked: Node resolves realpaths, so a symlink would resolve to this checkout and every
"am I installed?" test would answer no — the whole point lost. And the library's runtime
dependencies are real copies rather than symlinks, because a production bundle inlines them
from npm and the artifact records every module's path relative to the repository; a symlink
resolves outside the probe, and the build refuses a module it cannot place.

The probe's `index.html` pastes the installed package's own `lib/importmap.json`, so no
specifier and no hash in the fixture can go stale.

**Two packages release together**, and `verify-deps.mjs` now says so: the versions must
match, the peer range must name the library's exact version, and the toolchain's pins must
be the ones this repository runs the build with, none of them a range.

## Consequences

The gap ADR-0067 left open is closed. A packaging change that works in the checkout and
fails once installed now fails in `npm run check`, roughly forty seconds after it is made,
instead of in a consumer's CI.

`npm run check` packs the workspaces, so it depends on `source/dist/` existing — it runs
after `npm run package`, which builds it. It also shells out to `npm pack` and `tar`, which
is two more assumptions about the machine than any other check makes.

The probe is not a real install. It has no lockfile, resolves nothing from the network, and
borrows every third-party dependency from this repository by symlink. What it faithfully
reproduces is the one thing that matters here: two real package directories under
`node_modules`, and a repository that is the working directory. A packaging bug that needs
a true `npm install` to appear — a peer range npm refuses, a file `files` omits that only
matters transitively — is still not covered, though the tarballs themselves are, because
they are what gets extracted.

The fixture application is a fifth description of what an `index.html` has to contain. It
satisfies the eight production HTML facts (ADR-0041) because a consumer's page must, and a
change to that contract now breaks the probe too. That is a cost worth naming: it is one
more place to edit, and it is also the only place that would have caught the contract
being unsatisfiable from outside this repository.

`maxNodeModuleJsDepth: 1` is inherited by this repository as well, where it does nothing
useful — the library is not under `node_modules` here. It is not free anywhere: other
packages' JavaScript enters the program. Nothing has surfaced from it yet, and if something
does, the answer is for the base to stop setting it and for the library to publish
declarations instead, which is the ADR-0066 conversation.

`srl check templates` in a consumer covers their templates and says how many it skipped.
The library's own are checked where they are written, which is correct and is also weaker
than it sounds: a consumer upgrading the library gets no signal that a component's markup
changed under them until something renders.
