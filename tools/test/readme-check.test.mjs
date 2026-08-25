import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

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
  const { drifted } = await checkReadme();
  assert.deepEqual(drifted, [], 'run `npm run docs:write` and commit the result');
});

void test('a hand-edited generated row is reported as drift', async () => {
  const file = await copyReadme();
  const text = await readFile(file, 'utf8');
  await writeFile(file, text.replace('`ui-table`', '`ui-grid`'), 'utf8');

  const { drifted } = await checkReadme({ file });
  assert.ok(drifted.includes('elements'), `expected the elements table to drift, got ${drifted.join(', ')}`);

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

void test('a missing or unknown marker fails instead of being skipped', async () => {
  const file = await copyReadme();
  const text = await readFile(file, 'utf8');

  await writeFile(file, text.replace('<!-- generated:globals -->', '<!-- was here -->'), 'utf8');
  await assert.rejects(checkReadme({ file }), /no <!-- generated:globals --> block/u);

  await writeFile(file, `${text}\n<!-- generated:routes -->\n<!-- /generated:routes -->\n`, 'utf8');
  await assert.rejects(checkReadme({ file }), /not a section this tool generates/u);

  await writeFile(file, `${text}\n<!-- generated:elements -->\n`, 'utf8');
  await assert.rejects(checkReadme({ file }), /appears twice/u);
});
