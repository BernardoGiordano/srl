# ADR-0098: The first application is proved from its declared dependencies

- Status: accepted
- Date: 2026-09-09
- Affects: `tools/fixtures/installed-layout.mjs`, `tools/checks/pack-check.mjs`, `tools/conformance/fixture.mjs`, `cli/scaffold/application.mjs`, `cli/delivery/build.mjs`, `cli/README.md`

## Context

The packaged-install probe had real `@srljs/core` and `@srljs/cli` directories, but it
did not perform an install. It extracted both tarballs itself, then linked every package
in this repository's `node_modules` into the probe. Its empty `package.json` declared none
of them. The arrangement proved package paths and files, which was the limited decision in
[ADR-0068](0068-the-installed-shape-is-checked-by-installing.md), while it could not catch
an invalid peer relationship, a missing application dependency or an undeclared package
that happened to be present in this checkout.

The documented first journey exposed that limit. `npm install --save-dev @srljs/cli`
followed by `srl new web` omitted the application-owned `tailwindcss` and
`@tailwindcss/cli` packages the production build requires and the `@types/node` library
the generated `tsconfig.json` names. A local npm binary is not normally on a shell's
`PATH`, and the build also needs a Git commit for its release identity. The probe supplied
all four facts out of band: it invoked the CLI by an absolute path, borrowed Tailwind and
the type library from the checkout, and created a commit itself.

Rejected: keep the simulated layout and assert its package manifest. The assertion would
prove text while the resolver still saw every undeclared checkout dependency. It could
not expose the mismatch that forced this decision.

Rejected: make Tailwind a dependency of `@srljs/cli`. The stylesheet and its Tailwind
version belong to the application. A transitive compiler would silently choose how to
interpret source the application owns, reversing the ownership already enforced by the
build.

## Decision

The installed application fixture owns one package manifest. It declares exact versions
of `@srljs/core`, `@srljs/cli`, `tailwindcss`, `@tailwindcss/cli` and `@types/node`, derived
from the package manifests and lockfile in this checkout. Both installed adapters use it:
the packaged-install probe and editor conformance.

`tools/fixtures/installed-layout.mjs` packs both workspaces and gives those tarballs to a
real `npm install`. npm resolves the declared application dependencies and their
transitive dependencies from its cache in offline mode. Nothing is copied or linked from
this checkout's `node_modules`. The normal contributor setup has already installed the
same exact versions, so the cache is an input already required by `npm run check`; an
absent entry is an explicit install failure.

The same module invokes `srl` with `npx --offline --no-install`. The command must resolve
the project's installed binary and cannot fetch another version. The pack probe now
exercises the documented order: install, scaffold, import-map check, template check,
commit and build. The application files still come from the existing scaffold module.

The package README states Node.js 22, npm and Git as prerequisites and gives the complete
copyable journey, including both Tailwind packages, the Node type library and the first
commit. The production build translates an absent Git commit into its own release
diagnostic instead of exposing the child process failure.

## Consequences

The pack check now proves npm's peer resolution, transitive package layout, published
files, local binary and first production build from one declared dependency set. Editor
conformance starts from the same installed application rather than a broader checkout
environment, so a package available only by accident cannot make either adapter pass.

The check performs a second npm installation and copies a real dependency tree for the
second editor fixture. This costs more time and temporary disk than symlinks. Offline mode
avoids adding registry availability to `npm run check`, but a contributor who removes the
cache after setup must run `npm install` again before the pack check.

The two srl packages still come from local tarballs, because unpublished bytes cannot be
installed from the registry. Registry publication itself remains release evidence rather
than checkout evidence. This decision reopens if another package manager becomes a
supported installation interface; it must then be an adapter over the same declared
application dependency set and journey.
