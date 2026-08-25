# ADR-0067: The toolchain is a second package, pinned to the first

- Status: accepted
- Date: 2026-08-25
- Affects: `cli/package.json`, `cli/layout.mjs`, `cli/package/interface.mjs`, `source/package.json`, `package.json`

## Context

[ADR-0033](0033-the-library-publishes-its-own-interface.md) split the library's facts from
the repository's, and [ADR-0066](0066-the-registry-consumer-gets-bundles.md) gave the
library two published shapes. Both were about the library. Neither published the tools.

`@srljs/core` ships `dist`, `lib` and `components`. It does not ship the dev server, the
project model, the template checker or the artifact build, and none of those is optional
for a repository that deploys an application: the production artifact — minified,
hash-named chunks with a sha384 pinned for every one of them — is what the delivery tooling
emits and nothing else does.

So a repository built on srl had two ways to get a build, and both were wrong. It could
copy the tools, which means a fork that stops receiving fixes on the day it is made. Or it
could add an srl checkout as a git submodule and run the tools out of it, which is what
[santella.dev](https://santella.dev) did: `submodules: true` in the workflow, a second
`npm ci --prefix srl` to install Vite and parse5 from srl's own lockfile, and
`SRL_ROOT=. node srl/tools/delivery/build.mjs`.

That arrangement worked and was still wrong, for a reason worse than the ceremony. Two
copies of the library reached one repository: `npm start` served
`node_modules/@srljs/core/lib`, and `npm run build` bundled `srl/source/lib` from the
submodule. A version skew between them is a production artifact running a framework the
development server never ran, and the only thing standing between the two was a
hand-written check whose entire job was to notice.

Folding the tools into `@srljs/core` would fix the skew and break something else. The build
needs Vite, parse5 and the TypeScript compiler API. Declaring those as dependencies of the
library would make a page that loads the framework as source through an import map — the
consumer this framework is *for*, who never runs a bundler — install a hundred megabytes of
one. Declaring them as optional peers is the copied-pin problem again, one layer up: the
consumer states versions the toolchain has to hope are the ones it was tested against.

## Decision

The toolchain is `@srljs/cli`, a second published package in a second directory, `cli/`,
with its own `package.json` — the same arrangement `source/` already has, so extracting it
is a file move rather than an interface redesign.

`cli/` holds every tool a repository built on srl needs: `dev/serve.mjs`, `project-model/`,
`checks/template-check.mjs`, `delivery/` and the two modules everything asks —
`layout.mjs` and `package/interface.mjs`. `tools/` at the repository root keeps the tools
that only make sense inside this repository — the vendor refresh, the bundle build, the
interface and documentation checks, the benchmark harness — and is published nowhere.

Vite, TypeScript and parse5 are `dependencies` of `@srljs/cli`, pinned exactly. A consumer
gets the versions the toolchain was tested against because the toolchain ships its pins,
which is the whole point of publishing it. `@srljs/core` keeps its two runtime
dependencies and nothing else.

`@srljs/core` is a `peerDependency` pinned to the exact version, not a range. This package
reads the library's manifest for the mounts and specifier prefixes, and imports three of
its modules outright: the manifest policy the build admits remotes against is the policy
the runtime enforces, and the dialect the template checker refuses expressions with is the
dialect the renderer refuses them with. A range would let a consumer pair a checker with a
dialect it does not describe, and the build would pass what the browser then rejects. The
two are one interface split across two tarballs, and they release together.

Those three modules are named in the library's `exports` one by one. `./lib/*` is what
ADR-0066 closed and stays closed: every module under `lib/` imports `@core/` prefixes no
Node resolver knows about, so a wildcard would advertise a surface that throws one import
down. These three carry those prefixes only in JSDoc `@import` comments, which are erased
before Node sees them, and `tools/test/frozen-interface.test.mjs` fails if one of them ever
grows a runtime import of a prefix. Their `types.js` siblings are exported under a `types`
condition alone, so the type checker resolves them and Node refuses to — which is the
literal truth about a subpath whose file is a declaration with no runtime form.

Two facts have to be found at runtime rather than written down, and each has exactly one
sensible answer per arrangement.

**Where the library is.** `cli/package/interface.mjs` already searched for the directory
whose `package.json` carries an `srl` field, trying the parent of `cli/` and then
`source/`. Installed from the registry, neither exists: the two packages are siblings under
`node_modules`. So a third candidate asks the resolver — `import.meta.resolve('@srljs/core/package.json')` —
which is the only thing that survives npm's hoisting, pnpm's store and a linked checkout
alike. The checkout candidates are tried first, because a repository that has both a
checkout and an install was written against the checkout.

**Where the repository is.** `cli/layout.mjs` defaulted to the parent of `cli/`. Installed,
that parent is `node_modules/@srljs`, which is nobody's repository. So the default is the
working directory when this file sits under a `node_modules` path segment, and the parent
otherwise. `SRL_ROOT` still overrides both, for the arrangement neither default covers: a
repository that vendors or submodules a checkout below its own root.

The repository declares `workspaces: ["source", "cli"]`, so `@srljs/core/lib/...` resolves
to `source/lib/...` in a checkout. Without it the toolchain would work only once installed,
which is the one arrangement this repository could not test.

## Consequences

The submodule goes away. A consumer installs two dev dependencies, runs
`node node_modules/@srljs/cli/delivery/build.mjs --app web` from its own root with no
environment variable, and the build resolves the library through
`node_modules/@srljs/core`. One copy of the framework, so the skew the hand-written check
was watching for cannot happen: the development server and the build read the same bytes.

One rule had to change to make that true, and it was load-bearing. The build's import-map
resolver skipped any importer under `node_modules`, on the reasoning that a third-party
package resolving its own internals is not something an application's import map has an
opinion about. Once the library *is* under `node_modules`, that rule handed every `@core/`
import in the framework to a resolver that cannot see the map, and the build failed on the
first one. The exception is now explicit: an importer under `node_modules` that is not the
library. This is the shape of the whole problem — the tools were written where the library
was a sibling directory, and every place that assumed it had to be found and named.

Two packages release together, by hand, at matching versions. Nothing enforces that yet;
`npm run verify` checks that the toolchain's pins and the root `devDependencies` agree, and
that both packages carry a README and a LICENSE, but a release that published one tarball
and not the other would leave an unsatisfiable peer range and no check would have said so.

The repository's own suites run against `cli/` in a checkout, which is not the arrangement
a consumer has. The packaging bug above was found by packing both tarballs, installing them
into a scratch repository and building — by hand. Until that is a command, the installed
shape is verified the same way, which means it is verified when somebody remembers to.

`cli/README.md` is a second nested README, and CONTRIBUTING.md's rule against them now has
two exceptions rather than one. Both are the same exception: a package's landing page
addresses the consumer reading a registry rather than this repository, and a tarball that
ships without one publishes a blank listing.

Nothing about the browser changes. The library still ships as source, the import map is
still what resolves it, and an application that never deploys never installs any of this.
