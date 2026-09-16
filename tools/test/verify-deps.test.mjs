import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { errors } from '../../cli/diagnostics/index.mjs';
import { exists } from '../../cli/layout.mjs';
import { PACKAGE } from '../../cli/package/interface.mjs';
import { verifyDependencies } from '../checks/verify-deps.mjs';
import { BUNDLE_FILES, buildPackageBundles } from '../delivery/package-bundle.mjs';

/**
 * The dependency and layering gate, from the inside.
 *
 * Without exports, the only way to assert anything about this check would be to run
 * the process and match its output. ADR-0072. What is worth pinning is that the run is a
 * list a caller can read, rather than the wording of any one message, which is the
 * check's to improve. This repository satisfies every rule, and the checks that must
 * have run are nameable by code rather than countable.
 *
 * One call, shared, because the sweep walks every source file in the repository twice
 * and there is nothing per-case about it.
 */

/**
 * One of the rules below is that `exports` names files that are there, and the files
 * it names are generated. Built here when they are missing rather than left to
 * whichever suite happened to build them first, because that accident makes this file
 * fail intermittently. This is the only suite that writes `source/dist/`, so there is
 * no second process to race. A no-op after `npm run package`.
 */
if (!(await Promise.all(BUNDLE_FILES.map((file) => exists(join(PACKAGE, file))))).every(Boolean)) {
  await buildPackageBundles();
}

/** @type {Awaited<ReturnType<typeof verifyDependencies>>} */
let found;

void test('the repository satisfies its own dependency rules', async () => {
  found = await verifyDependencies();
  const refused = errors(found);
  assert.deepEqual(
    refused.map((diagnostic) => `${diagnostic.code} ${diagnostic.file ?? ''}`),
    [],
    refused.map((diagnostic) => diagnostic.message).join('\n'),
  );
});

void test('every rule reports that it ran, not merely that it passed', () => {
  const codes = new Set(found.map((diagnostic) => diagnostic.code));

  // One per section that has no per-application or per-file fan-out, so a check
  // silently skipped, whether a directory that stopped being walked or an application
  // that stopped being discovered, is a missing code rather than a smaller number.
  for (const code of [
    'deps/no-application-imports',
    'deps/import-map-fragment',
    'deps/bundles-cover-prefixes',
    'deps/tspaths',
    'deps/verbatim',
    'deps/prefixes',
    'deps/declared-specifiers',
    'deps/templates-resolve',
    'deps/preference-storage',
    'deps/one-documentation-surface',
    'deps/package-pages',
    'deps/one-version',
    'deps/peer-exact',
  ]) {
    assert.ok(codes.has(code), `no ${code} in the run`);
  }
});

void test('a finding is placed, so an editor or a CI annotation can point at it', () => {
  const placed = found.filter((diagnostic) => diagnostic.file !== null);
  assert.ok(placed.length > 0);

  for (const diagnostic of placed) {
    assert.ok(!diagnostic.file?.startsWith('/'), `${diagnostic.code} kept an absolute path`);
    assert.ok(!diagnostic.file?.includes('\\'), `${diagnostic.code} kept a platform separator`);
  }
});

void test('an application-scoped finding names the application', () => {
  const scoped = found.filter((diagnostic) => diagnostic.code === 'deps/verbatim');
  assert.ok(scoped.length > 0);
  for (const diagnostic of scoped) assert.ok(typeof diagnostic.group === 'string');
});
