import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import test from 'node:test';

import { walk } from '../../cli/layout.mjs';
import {
  DOCS,
  PUBLISHED,
  linkTarget,
  packageDocs,
  relativeLinks,
  staleDocs,
  writePackageDocs,
} from '../delivery/package-docs.mjs';

/**
 * The documentation each package ships.
 *
 * The property worth pinning is that an installed package can answer its own
 * citations. Every page reaches the index, every link lands inside the package, and a
 * copy that fell behind docs/ is reported. Malformed trees are built in a temporary
 * directory, so no case edits docs/ to prove the refusal.
 */

/** Joined, so docs:adr does not read the fixture's heading as a citation. */
const RECORD_ID = ['ADR', '0001'].join('-');

const RECORD = [
  `# ${RECORD_ID}: A decision`,
  '',
  '- Status: accepted',
  '- Date: 2026-09-17',
  '- Affects: `docs/`',
  '',
  '## Context',
  '',
  'Before.',
  '',
  '## Decision',
  '',
  'Now.',
  '',
  '## Consequences',
  '',
  'Cost.',
  '',
].join('\n');

const INDEX = [
  '# Documentation',
  '',
  '## Guide',
  '',
  '| Page | Subject |',
  '|---|---|',
  '| [First](guide/first.md) | The first page. |',
  '',
].join('\n');

/**
 * A package directory and a docs tree beside it.
 *
 * @param {Record<string, string>} pages Paths inside the docs tree, with their text.
 * @returns {Promise<{ root: string, docs: string }>}
 */
async function fixture(pages) {
  const base = await mkdtemp(join(tmpdir(), 'package-docs-'));
  const root = join(base, 'package');
  const docs = join(base, 'docs');
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: '@example/pkg', version: '1.2.3', description: 'An example.' }),
  );
  await writeFile(join(root, 'README.md'), '# @example/pkg\n');
  const tree = { 'README.md': INDEX, 'adr/0001-a-decision.md': RECORD, ...pages };
  for (const [path, text] of Object.entries(tree)) {
    await mkdir(join(docs, path, '..'), { recursive: true });
    await writeFile(join(docs, path), text);
  }
  return { root, docs };
}

void test('the shipped index lists every guide, reference page and record', async () => {
  const [core] = PUBLISHED;
  assert.ok(core !== undefined);
  const files = await packageDocs(core);
  const index = files.get('llms.txt') ?? '';
  const listed = new Set(relativeLinks(index));

  for (const file of await walk(DOCS, /\.md$/u)) {
    const path = `docs/${relative(DOCS, file).split(sep).join('/')}`;
    assert.ok(files.has(path), `${path} is not copied`);
    if (path === 'docs/README.md' || path === 'docs/adr/0000-template.md') continue;
    if (path.startsWith('docs/adr/') || path.startsWith('docs/guide/') || path.startsWith('docs/reference/')) {
      assert.ok(listed.has(path), `${path} is not in llms.txt`);
    }
  }

  assert.match(index, /^# @srljs\/core\n/u);
  assert.match(index, /\[ADR-0121: The install carries its own documentation\]\(docs\/adr\/0121-/u);
});

void test('a link that leaves the package is refused', async () => {
  const { root, docs } = await fixture({
    'guide/first.md': '# First\n\nSee [the parser](../../source/lib/core/template/dialect.js).\n',
  });
  await assert.rejects(packageDocs(root, { docs }), /guide\/first\.md links to \.\.\/\.\.\/source/u);
});

void test('a link to a file the package has is kept', async () => {
  const { root, docs } = await fixture({
    'guide/first.md': '# First\n\n[README](../../README.md), [records](../adr/), [top](#first).\n',
  });
  const files = await packageDocs(root, { docs });
  assert.ok(files.has('docs/guide/first.md'));
});

void test('a page the index does not list is refused', async () => {
  const { root, docs } = await fixture({
    'guide/first.md': '# First\n',
    'guide/second.md': '# Second\n',
  });
  await assert.rejects(packageDocs(root, { docs }), /docs\/guide\/second\.md is not in docs\/README\.md/u);
});

void test('a stale or extra copy is reported, and a rewrite clears it', async () => {
  const { root, docs } = await fixture({ 'guide/first.md': '# First\n' });
  const files = await packageDocs(root, { docs });
  assert.deepEqual(await staleDocs(root, files), [...files.keys()].sort());

  await writePackageDocs(root, files);
  assert.deepEqual(await staleDocs(root, files), []);
  assert.match(await readFile(join(root, 'llms.txt'), 'utf8'), /- \[First\]\(docs\/guide\/first\.md\): The first page\./u);

  await writeFile(join(root, 'docs', 'guide', 'first.md'), '# Edited\n');
  await writeFile(join(root, 'docs', 'guide', 'removed.md'), '# Gone\n');
  assert.deepEqual(await staleDocs(root, files), ['docs/guide/first.md', 'docs/guide/removed.md']);

  await writePackageDocs(root, files);
  assert.deepEqual(await staleDocs(root, files), []);
});

void test('a link resolves against the page it is written in', () => {
  assert.equal(linkTarget('docs/guide/a.md', '../reference/b.md'), 'docs/reference/b.md');
  assert.equal(linkTarget('docs/README.md', '../README.md'), 'README.md');
  assert.equal(linkTarget('docs/README.md', 'adr/'), 'docs/adr');
  assert.equal(linkTarget('docs/README.md', '../../README.md'), null);
  assert.deepEqual(relativeLinks('[a](b.md#x) [c](https://x.dev) [d](#e) [f](g/)'), ['b.md', 'g/']);
});
