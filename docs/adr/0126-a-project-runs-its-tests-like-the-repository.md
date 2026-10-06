# ADR-0126: A project runs its tests the way the repository does

- Status: accepted
- Date: 2026-10-06
- Affects: `cli/testing/web-test-runner.mjs`, `web-test-runner.config.mjs`, `cli/scaffold/project.mjs`, `cli/package.json`, `tools/checks/verify-deps.mjs`, `tools/checks/pack-check.mjs`, `tools/fixtures/installed-layout.mjs`, `example/test/`, `docs/guide/testing.md`

## Context

The test harness shipped as `@srljs/core/testing/harness.js`, but nothing a consumer
installed could run a component test with it. The URL rewrite that makes the runner's
origin look like a deployed one lived in this repository's `web-test-runner.config.mjs`.
The example's suites imported the harness from `../../source/lib/test/`, a path no
consumer has, and the testing guide was contributor notes. `srl new` wrote no test and
no `test` script, waiting for this.

Two alternatives lost.

- An `srl test` command would wrap the runner and hide its configuration, and the CLI
  would depend on `@web/test-runner` for every project, tested or not.
- A copy of the configuration in the scaffold would be one more copy of the mount table,
  free to drift from the one every srl origin resolves with.

## Decision

**The CLI publishes the configuration.** `testRunnerConfig({ app })` in
`cli/testing/web-test-runner.mjs` returns a `@web/test-runner` configuration. It serves
the project root and rewrites each URL with `resolveMount` from `cli/origin/`. The
library's mounts come from `cli/layout.mjs`, and the application's routes come from its
top-level entries, so a file added at the application root resolves without an edit. The
test page carries the application's import map, enforces Trusted Types for the library's
policies, and maps `@srljs/core/testing/harness.js` to the harness, the name `exports`
already gives it. This repository's configuration calls the preset with the library and
collection suites as more `files`.

**`@web/test-runner` is an optional peer.** A project that runs browser tests installs
it, and one that does not installs no browser tooling. The preset imports nothing from
it.

**`srl new` writes a project that tests.** It writes `web-test-runner.config.mjs`, a
`test` script, one test of the home page, and `@web/test-runner` and `@types/mocha` at
the versions this repository locks. The packaged-install probe runs `npm run test` in
the scaffolded project.

**A test imports the published harness.** The example's suites import
`@srljs/core/testing/harness.js`, and `npm run verify` accepts that specifier in an
application's `test/` directory, because the test page maps it.

## Consequences

- A consumer's first test runs with no configuration of their own.
- The preset is the one place that knows how a test page differs from a deployed page.
- The probe needs Chrome, as the repository's own browser suites already do.
- `srl generate app` writes no test, because the project's configuration names one
  application. A second application adds a `files` glob or a configuration of its own.
- Reopen this if a second runner becomes supported, or if the CLI starts launching
  browsers for another reason.
