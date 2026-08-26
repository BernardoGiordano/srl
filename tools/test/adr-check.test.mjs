import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { errors } from '../../cli/diagnostics/index.mjs';
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

/**
 * Every refusal a directory produces, as its codes and as one blob of text.
 *
 * Both, because the two say different things: the code is the contract a suite should
 * pin, and the wording is what a person reads at three in the morning.
 *
 * @param {string} dir
 * @returns {Promise<{ codes: string[], text: string }>}
 */
async function refusals(dir) {
  const refused = errors((await readRecords(dir)).diagnostics);
  return {
    codes: refused.map((diagnostic) => diagnostic.code),
    text: refused.map((diagnostic) => diagnostic.message).join('\n'),
  };
}

void test('the committed records are well formed and every citation resolves', async () => {
  const refused = errors((await checkAdrs()).diagnostics);
  assert.deepEqual(refused, [], refused.map((diagnostic) => diagnostic.message).join('\n'));
});

void test('a well-formed record is read', async () => {
  const dir = await fixture({ '0042-a-decision.md': WELL_FORMED });
  const { records, diagnostics } = await readRecords(dir);
  assert.deepEqual(errors(diagnostics), []);

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
  assert.deepEqual([...(await readRecords(dir)).records.keys()], ['ADR-0042']);
});

void test('a number that disagrees with its filename fails', async () => {
  const dir = await fixture({ '0043-a-decision.md': WELL_FORMED });
  const refused = await refusals(dir);
  assert.deepEqual(refused.codes, ['adr/number-mismatch']);
  assert.match(refused.text, /the heading says ADR-0042, the filename says 0043/u);
});

void test('a filename that is not NNNN-kebab-title fails', async () => {
  const dir = await fixture({ 'a-decision.md': WELL_FORMED });
  const refused = await refusals(dir);
  assert.deepEqual(refused.codes, ['adr/filename']);
  assert.match(refused.text, /a record is named NNNN-kebab-title\.md/u);
});

void test('a duplicate number fails, because a citation would be ambiguous', async () => {
  const dir = await fixture({
    '0042-a-decision.md': WELL_FORMED,
    '0042-another-decision.md': WELL_FORMED,
  });
  const refused = await refusals(dir);
  assert.deepEqual(refused.codes, ['adr/duplicate-number']);
  assert.match(refused.text, /ADR-0042 is already/u);
});

void test('a missing field or section fails', async () => {
  /** @type {Array<[string, string, RegExp]>} */
  const cases = [
    ['- Status: accepted', 'adr/missing-field', /no `- Status:` field/u],
    ['- Date: 2026-08-12', 'adr/missing-field', /no `- Date:` field/u],
    ['- Affects: `source/lib/core/`', 'adr/missing-field', /no `- Affects:` field/u],
    ['## Context', 'adr/missing-section', /no `## Context` section/u],
    ['## Decision', 'adr/missing-section', /no `## Decision` section/u],
    ['## Consequences', 'adr/missing-section', /no `## Consequences` section/u],
  ];

  for (const [line, code, expected] of cases) {
    const dir = await fixture({ '0042-a-decision.md': WELL_FORMED.replace(`${line}\n`, '') });
    const refused = await refusals(dir);
    assert.deepEqual(refused.codes, [code], `removing "${line}" was accepted`);
    assert.match(refused.text, expected);
  }
});

void test('every problem in one record is reported in one run', async () => {
  // The reason a malformed record is a list of findings rather than a throw: a record
  // missing three sections should take one run to fix, not three.
  const dir = await fixture({
    '0042-a-decision.md': WELL_FORMED.replace('## Decision\n', '').replace('## Consequences\n', ''),
  });
  assert.deepEqual((await refusals(dir)).codes, [
    'adr/missing-section',
    'adr/missing-section',
  ]);
});

void test('an unknown status and a malformed date fail', async () => {
  const bad = await fixture({
    '0042-a-decision.md': WELL_FORMED.replace('Status: accepted', 'Status: probably'),
  });
  const status = await refusals(bad);
  assert.deepEqual(status.codes, ['adr/unknown-status']);
  assert.match(status.text, /is not one of/u);

  const dated = await fixture({
    '0042-a-decision.md': WELL_FORMED.replace('Date: 2026-08-12', 'Date: August 2026'),
  });
  const date = await refusals(dated);
  assert.deepEqual(date.codes, ['adr/malformed-date']);
  assert.match(date.text, /is not YYYY-MM-DD/u);
});

void test('a superseded record must name the record that replaced it', async () => {
  const orphaned = await fixture({
    '0042-a-decision.md': WELL_FORMED.replace('Status: accepted', 'Status: superseded'),
  });
  const refused = await refusals(orphaned);
  assert.deepEqual(refused.codes, ['adr/superseded-without-successor']);
  assert.match(refused.text, /names the record that replaced it/u);

  const named = await fixture({
    '0042-a-decision.md': WELL_FORMED.replace('Status: accepted', 'Status: superseded by ADR-0043'),
  });
  assert.equal(
    (await readRecords(named)).records.get('ADR-0042')?.status,
    'superseded by ADR-0043',
  );
});

void test('a refusal names the file it is about', async () => {
  const dir = await fixture({ '0042-a-decision.md': WELL_FORMED.replace('## Context\n', '') });
  const [refused] = errors((await readRecords(dir)).diagnostics);
  assert.ok(String(refused?.file).endsWith('0042-a-decision.md'));
});
