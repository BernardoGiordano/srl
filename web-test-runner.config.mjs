/**
 * Tests run in a real browser against the real source files, through the preset the
 * CLI publishes for every srl project. This repository is one more caller of it.
 * ADR-0126.
 *
 * Three suites share one origin.
 *
 * source/lib/test/  tests the framework, and nothing in it may import from an
 *                   application. If one of these tests needs example to pass, the
 *                   boundary has leaked and that is the bug.
 * source/components/test/
 *                   tests the shared component collection, under the same rule. These
 *                   components are built on the library and know no application, so
 *                   their tests must not need one either.
 * <APP>/test/       tests one application end to end, including the real manifest
 *                   fetch, the real router and the real remotes.
 *
 * The application under test is chosen by APP, so a second application is
 * `APP=poc-xyz npm test` and no edit here.
 */

import { testRunnerConfig } from './cli/testing/web-test-runner.mjs';

export default testRunnerConfig({
  app: process.env.APP ?? 'example',
  files: ['source/lib/test/**/*.test.js', 'source/components/test/**/*.test.js'],
});
