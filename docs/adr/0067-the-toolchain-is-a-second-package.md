# ADR-0067: The toolchain is a second package, pinned to the first

- Status: accepted
- Date: 2026-08-25
- Affects: `cli/package.json`, `cli/layout.mjs`, `cli/package/interface.mjs`, `source/package.json`, `package.json`

## Context

`@srljs/core` ships the runtime. A repository that deploys an application also needs the dev server, the project model, the template checker and the artifact build.

Copying the tools creates a fork that stops getting fixes. Running them from a git submodule put two copies of the library in one repository, one served in development and one bundled for production, and a version skew between them would ship code the dev server never ran.

Adding the tools to `@srljs/core` would force a page that loads the framework as source to install Vite, parse5 and the TypeScript compiler.

## Decision

The toolchain is `@srljs/cli`, published from `cli/` with its own `package.json`. `tools/` keeps what only makes sense inside this repository and is never published.

Vite, TypeScript and parse5 are exact-pinned dependencies of `@srljs/cli`. `@srljs/core` keeps its two runtime dependencies.

`@srljs/core` is a peer dependency at the exact same version. The CLI reads the library's manifest and imports several of its modules directly, including the manifest policy and the template dialect. A version range would let the checker enforce a different dialect from the one the browser runs, so the two packages release together.

The CLI looks for the library in a checkout first and then through `import.meta.resolve('@srljs/core/package.json')`. When installed under `node_modules`, it takes the repository root from the working directory. `SRL_ROOT` overrides both. The root `package.json` declares `workspaces: ["source", "cli"]`, so a checkout resolves the same way an install does.

## Consequences

- A consumer installs two dev dependencies and runs the build from its own root. There is one copy of the framework, so development and production read the same bytes.
- The build's import map resolver skips importers under `node_modules` except the library itself, whose `@core/` imports still need the map.
- `npm run verify` checks that the versions and the peer range agree. `pack-check.mjs` packs both tarballs, installs them in a scratch repository and builds.
- `cli/README.md` is the second package landing page, alongside `source/README.md`.
