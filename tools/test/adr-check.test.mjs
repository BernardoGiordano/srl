import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { checkAdrs, readRecords } from '../checks/adr-check.mjs';

/**
 * The decision-record gate.
 *
 * A record's number is what source comments cite, so the two properties worth pinning
 * are that a citation always resolves and that a record cannot be half-formed. Every
 * malformed case is built in a temporary directory: a suite that writes a broken record
 * into docs/adr to prove the check sees it is a suite that leaves the repository failing
 * its own check.
 */

const WELL_FORMED = [
  '# ADR-0042: A decision',
  '',
  '- Status: accepted',
  '- Date: 2026-08-12',
  '- Affects: `source/lib/core/`',
  '',
  '## Context',
  '',
  'What was true before.',
  '',
  '## Decision',
  '',
  'What is true now.',
  '',
  '## Consequences',
  '',
  'What it costs.',
  '',
].join('\n');

/**
 * @param {Record<string, string>} files
 * @returns {Promise<string>} a scratch record directory
 */
async function fixture(files) {
  const dir = await mkdtemp(join(tmpdir(), 'adr-check-'));
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text, 'utf8');
  return dir;
}

void test('the committed records are well formed and every citation resolves', async () => {
  const { problems } = await checkAdrs();
  assert.deepEqual(problems, [], problems.join('\n'));
});

void test('a well-formed record is read', async () => {
  const dir = await fixture({ '0042-a-decision.md': WELL_FORMED });
  const records = await readRecords(dir);

  const record = records.get('ADR-0042');
  assert.ok(record !== undefined, 'ADR-0042 was not read');
  assert.equal(record.title, 'A decision');
  assert.equal(record.status, 'accepted');
  assert.equal(record.file, '0042-a-decision.md');
});

void test('the index and the template are not records', async () => {
  const dir = await fixture({
    '0042-a-decision.md': WELL_FORMED,
    'README.md': '# Decision records\n',
    '0000-template.md': WELL_FORMED.replace('ADR-0042', 'ADR-0000'),
  });
  assert.deepEqual([...(await readRecords(dir)).keys()], ['ADR-0042']);
});

void test('a number that disagrees with its filename fails', async () => {
  const dir = await fixture({ '0043-a-decision.md': WELL_FORMED });
  await assert.rejects(readRecords(dir), /the heading says ADR-0042, the filename says 0043/u);
});

void test('a filename that is not NNNN-kebab-title fails', async () => {
  const dir = await fixture({ 'a-decision.md': WELL_FORMED });
  await assert.rejects(readRecords(dir), /a record is named NNNN-kebab-title\.md/u);
});

void test('a duplicate number fails, because a citation would be ambiguous', async () => {
  const dir = await fixture({
    '0042-a-decision.md': WELL_FORMED,
    '0042-another-decision.md': WELL_FORMED,
  });
  await assert.rejects(readRecords(dir), /ADR-0042 is already/u);
});

void test('a missing field or section fails', async () => {
  /** @type {Array<[string, RegExp]>} */
  const cases = [
    ['- Status: accepted', /no `- Status:` field/u],
    ['- Date: 2026-08-12', /no `- Date:` field/u],
    ['- Affects: `source/lib/core/`', /no `- Affects:` field/u],
    ['## Context', /no `## Context` section/u],
    ['## Decision', /no `## Decision` section/u],
    ['## Consequences', /no `## Consequences` section/u],
  ];

  for (const [line, expected] of cases) {
    const dir = await fixture({ '0042-a-decision.md': WELL_FORMED.replace(`${line}\n`, '') });
    await assert.rejects(readRecords(dir), expected, `removing "${line}" was accepted`);
  }
});

void test('an unknown status and a malformed date fail', async () => {
  const bad = await fixture({
    '0042-a-decision.md': WELL_FORMED.replace('Status: accepted', 'Status: probably'),
  });
  await assert.rejects(readRecords(bad), /is not one of/u);

  const dated = await fixture({
    '0042-a-decision.md': WELL_FORMED.replace('Date: 2026-08-12', 'Date: August 2026'),
  });
  await assert.rejects(readRecords(dated), /is not YYYY-MM-DD/u);
});

void test('a superseded record must name the record that replaced it', async () => {
  const orphaned = await fixture({
    '0042-a-decision.md': WELL_FORMED.replace('Status: accepted', 'Status: superseded'),
  });
  await assert.rejects(readRecords(orphaned), /names the record that replaced it/u);

  const named = await fixture({
    '0042-a-decision.md': WELL_FORMED.replace('Status: accepted', 'Status: superseded by ADR-0043'),
  });
  assert.equal((await readRecords(named)).get('ADR-0042')?.status, 'superseded by ADR-0043');
});
