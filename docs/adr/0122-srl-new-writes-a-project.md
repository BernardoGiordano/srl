# ADR-0122: `srl new` writes a project, and `srl generate` adds to one

- Status: accepted
- Date: 2026-09-17
- Affects: `cli/scaffold/`, `cli/bin/srl.mjs`, `cli/package.json`, `tools/fixtures/installed-layout.mjs`, `tools/checks/pack-check.mjs`, `tools/checks/verify-deps.mjs`, `tools/conformance/`, `cli/README.md`, `README.md`

## Context

`srl new web` wrote an application into a repository that had to exist already. Before
it ran, a developer typed `git init`, `npm init -y` and two installs with five exact
versions. The three quickstarts disagreed about those versions.

After it ran, the project still lacked parts every project needs.

- It had no scripts, so the loop was a set of `npx --no-install srl` lines to remember.
- It had no `.gitignore`, and the README's `git add .` committed `node_modules`.
- It had nothing that told a coding agent how to verify a change or where the installed
  documentation was.

ADR-0073 chose the smallest application that runs. That application was a counter that
defined its root directly and skipped `startApplication`. The manifest and the locale
bundle were written and never read, and adding a first route meant rewriting
`main.js`.

No command added a component. A developer copied a module and its template by hand, and
a missing export or `module: import.meta.url` surfaced later as a check failure.

Four alternatives lost.

- A `create-srl` package for `npm create srl` would be a third package to release in
  step with the pair, and it would only shorten `npx @srljs/cli new`.
- Keeping `srl new` in place and adding project files when they are missing makes one
  command behave differently depending on what the directory holds. It also still needs
  the CLI installed first, which is the step that needs the pins.
- Running `npm install` from `srl new` needs the network, picks the package manager, and
  takes the install away from the packaged-install probe.
- A scaffolded component test would be a file nothing can run, because the URL rewrite a
  consumer's test runner needs lives only in this repository's runner configuration.

## Decision

**`srl new <project>` writes a new project directory.** It contains `package.json`,
`.gitignore`, `AGENTS.md`, `tsconfig.json` and an application at `<project>/web/`.
`--app` renames the application. `package.json` pins `@srljs/core` and `@srljs/cli`
exactly, pins the application-owned Tailwind packages and Node types, and declares
`dev`, `check` and `build` scripts. The command installs nothing and does not run Git.
`npx @srljs/cli new my-app` is the whole setup. `cli/scaffold/project.mjs` holds the pure
`projectFiles(facts)` beside `applicationFiles(facts)`.

**The CLI owns the pins.** The pair comes from the CLI's own version and the version of
the library whose import map the application pastes. The tool versions sit in
`scaffold.devDependencies` in `cli/package.json`. `npm run verify` reports
`deps/scaffold-drift` when a scaffold pin differs from the version the repository
lockfile installs.

**The application boots the way a real one does.** `main.js` calls `startApplication`.
The root element attaches the router, and the one route loads the home page lazily. The
home page reads both messages in the locale bundle. The page, the build or a check reads
every file the scaffold writes. The lazy root and the lazy page give the build the
second chunk it requires.

**A new project reaches the library through its own install.** Under npx the CLI runs
from npx's cache, and the new project has installed nothing yet. The stylesheet imports
therefore point at `<project>/node_modules/@srljs/core`. `srl generate app` keeps
pointing at the package the current project installed.

**`srl generate` adds to an existing project.** `srl generate app <name>` writes an
application, which is what `srl new <name>` used to do. `srl generate component
<[dir/]tag>` writes a module and its template under `<app>/src/components/`, or under
`<app>/src/<dir>/` when a directory is given. `--styles` adds the scoped stylesheet
(ADR-0119). The command refuses an invalid or reserved tag, a tag the project model
already knows from the application, the library or the collection, and any file that
exists. Every refusal happens before anything is written.

**The scaffold findings share one namespace.** `cli/scaffold/files.mjs` validates names
and writes files, and every scaffold reports `scaffold/*` codes. They are not `srl check`
codes, so the catalogue does not list them (ADR-0120).

**The probe drives the journey.** `tools/checks/pack-check.mjs` installs the pair into a
launcher directory and runs `srl new` from it with `npx --prefix`, so the working
directory is the probe, as it is under npx. It installs the project from the manifest the
scaffold wrote, and the install refuses any pin other than the versions this checkout
proves (ADR-0098). It generates a styled component and puts it on the home page. It
commits with `git add .` and refuses the run when anything under `node_modules/` or
`dist/` was committed. Then it runs `npm run check` and `npm run build`. Editor
conformance builds its projects the same way (ADR-0097).

## Consequences

- The quickstart is four commands: `npx @srljs/cli@<version> new my-app`, `cd my-app`,
  `npm install` and `npm run dev`.
- `srl new web` inside an existing repository now creates a project named `web` with
  its own `web/web/`. `srl generate app web` does what the old command did.
- The first `npm run build` still needs a Git commit. `srl new` says so when it finishes.
- A Tailwind upgrade in this repository fails `npm run verify` until
  `scaffold.devDependencies` follows it.
- The scaffold writes no test and no `test` script. It gains both when the test runner's
  URL rewrite is published.
- The scaffolded manifest still carries `auth` and `remotes`, because admission requires
  every section (ADR-0010).
- ADR-0073's choice of the smallest application that runs no longer holds. Its other
  decisions do.
- Reopen this if another package manager becomes a supported install path, or if
  `srl new` needs to write into a directory that already exists.
