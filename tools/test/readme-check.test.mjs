import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { errors } from '../../cli/diagnostics/index.mjs';
import { REPO } from '../../cli/layout.mjs';
import { checkReadme } from '../checks/readme-check.mjs';

/**
 * The documentation gate.
 *
 * The tables that state which elements exist, where they live and what they may name are
 * generated from the project model rather than typed, and they live on the reference page
 * the generator owns. These tests pin the two properties that make that worth doing: the
 * committed page currently agrees with the source, and a page that stops agreeing fails
 * rather than being quietly out of date.
 *
 * Every case works on a copy in a temporary directory. A test that rewrites the
 * repository's own page to prove it can is a test that leaves the repository dirty.
 */

/** The page the generator writes when `--file` says nothing. */
const TARGET = 'docs/reference/project-index.md';

/** @returns {Promise<string>} a scratch copy of the committed reference page */
async function copyReadme() {
  const dir = await mkdtemp(join(tmpdir(), 'readme-check-'));
  const file = join(dir, 'project-index.md');
  await writeFile(file, await readFile(join(REPO, TARGET), 'utf8'), 'utf8');
  return file;
}

void test('the committed project index agrees with the project model', async () => {
  const { diagnostics, drifted } = await checkReadme();
  assert.deepEqual(drifted, [], 'run `npm run docs:write` and commit the result');
  assert.deepEqual(
    errors(diagnostics).map((diagnostic) => diagnostic.code),
    [],
  );
});

void test('a hand-edited generated row is reported as drift', async () => {
  const file = await copyReadme();
  const text = await readFile(file, 'utf8');
  await writeFile(file, text.replace('`ui-table`', '`ui-grid`'), 'utf8');

  const { diagnostics, drifted } = await checkReadme({ file });
  assert.ok(drifted.includes('elements'), `expected the elements table to drift, got ${drifted.join(', ')}`);

  // The finding, not a count: the page and the section it drifted in are both on the
  // diagnostic, which is what an editor underlines and a CI job reads.
  const [drift] = errors(diagnostics);
  assert.equal(drift?.code, 'docs/generated-drift');
  assert.ok(String(drift?.file).endsWith('project-index.md'));
  assert.match(String(drift?.message), /elements/u);

  // And the file is untouched until --write says otherwise.
  assert.ok((await readFile(file, 'utf8')).includes('`ui-grid`'));
});

void test('--write restores a drifted section and leaves the prose alone', async () => {
  const file = await copyReadme();
  const before = await readFile(file, 'utf8');
  await writeFile(file, before.replace('`ui-table`', '`ui-grid`'), 'utf8');

  await checkReadme({ file, write: true });
  const after = await readFile(file, 'utf8');

  assert.ok(!after.includes('`ui-grid`'));
  assert.deepEqual((await checkReadme({ file })).drifted, []);
  assert.equal(after, before, 'a rewrite of an unmodified document must be a no-op');
});

/** @param {string} file @returns {Promise<string[]>} */
async function codes(file) {
  return errors((await checkReadme({ file })).diagnostics).map((diagnostic) => diagnostic.code);
}

void test('a missing or unknown marker fails instead of being skipped', async () => {
  const file = await copyReadme();
  const text = await readFile(file, 'utf8');

  await writeFile(file, text.replace('<!-- generated:globals -->', '<!-- was here -->'), 'utf8');
  assert.deepEqual(await codes(file), ['docs/missing-marker']);

  await writeFile(file, `${text}\n<!-- generated:routes -->\n<!-- /generated:routes -->\n`, 'utf8');
  assert.deepEqual(await codes(file), ['docs/unknown-section']);

  await writeFile(file, `${text}\n<!-- generated:elements -->\n`, 'utf8');
  assert.deepEqual(await codes(file), ['docs/duplicate-marker']);
});

void test('a broken document is not rewritten, even with --write', async () => {
  const file = await copyReadme();
  const before = await readFile(file, 'utf8');
  await writeFile(file, before.replace('<!-- generated:globals -->', '<!-- was here -->'), 'utf8');
  const broken = await readFile(file, 'utf8');

  const { diagnostics, text } = await checkReadme({ file, write: true });
  assert.equal(text, null, 'there is no correct rewrite of a document missing a marker');
  assert.deepEqual(
    errors(diagnostics).map((diagnostic) => diagnostic.code),
    ['docs/missing-marker'],
  );
  assert.equal(await readFile(file, 'utf8'), broken, 'and nothing was written over it');
});
