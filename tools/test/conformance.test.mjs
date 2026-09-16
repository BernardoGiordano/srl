/**
 * The scenario list and the parity report, without an editor.
 *
 * A conformance run costs an editor download and several minutes, so the things that
 * can be wrong about it before one starts are checked here. Those are a scenario nothing
 * can answer, two scenarios with one id, and a report that hides a failure. ADR-0097.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { findings, parity } from '../conformance/report.mjs';
import { SCENARIOS, only } from '../conformance/scenarios.mjs';
import { covers as vscodeCovers } from '../conformance/vscode.mjs';
import { covers as webstormCovers } from '../conformance/webstorm.mjs';

/** @import { AdapterRun } from '../conformance/types.js' */

/** Every ask the probe and the adapters implement between them. */
const ASKS = new Set([
  'servers',
  'restart',
  'orphans',
  'diagnostics',
  'completion',
  'hover',
  'definition',
  'rename',
  'watch',
  'trace',
]);

void test('the scenario list names each scenario once', () => {
  const ids = SCENARIOS.map((scenario) => scenario.id);
  assert.deepEqual([...new Set(ids)], ids);
});

void test('every scenario asks only what an adapter knows how to ask', () => {
  for (const scenario of SCENARIOS) assert.ok(ASKS.has(scenario.ask), `${scenario.id} asks ${scenario.ask}`);
});

void test('every scenario states what its answer has to contain', () => {
  for (const scenario of SCENARIOS) {
    assert.ok(Object.keys(scenario.expect).length > 0, `${scenario.id} expects nothing`);
    assert.ok(scenario.title.length > 0, `${scenario.id} has no title`);
  }
});

void test('every request that needs a position is anchored in a document', () => {
  for (const scenario of SCENARIOS) {
    if (!['completion', 'hover', 'definition', 'rename', 'watch'].includes(scenario.ask)) continue;
    assert.ok(scenario.document !== undefined && scenario.at !== undefined, `${scenario.id} has nowhere to ask`);
  }
});

void test('the list is answerable in full by one editor and in part by the other', () => {
  assert.ok(SCENARIOS.every((scenario) => vscodeCovers(scenario)));
  const covered = SCENARIOS.filter((scenario) => webstormCovers(scenario));
  assert.ok(covered.length > 0, 'no scenario is asked of WebStorm at all');
  assert.ok(covered.length < SCENARIOS.length, 'WebStorm is claimed to answer scenarios its platform cannot');
});

void test('a run selects scenarios by id', () => {
  assert.deepEqual(
    only(['session.start', 'nothing.here']).map((scenario) => scenario.id),
    ['session.start'],
  );
});

/** Two editors, one of which could not answer everything. @returns {AdapterRun[]} */
function reached() {
  /** @type {AdapterRun[]} */
  const runs = [
    {
      adapter: 'vscode',
      edition: 'minimum',
      version: '1.95.0',
      results: [
        { id: 'session.start', status: 'pass', detail: '' },
        { id: 'rename.tag', status: 'fail', detail: 'edited the other project' },
      ],
    },
    {
      adapter: 'webstorm',
      edition: 'installed',
      version: '2026.1',
      results: [
        { id: 'session.start', status: 'pass', detail: '' },
        { id: 'rename.tag', status: 'unavailable', detail: 'not answerable from outside the IDE' },
      ],
    },
  ];
  return runs;
}

void test('the report gives each editor a column and each scenario a row', () => {
  const table = parity(reached(), only(['session.start', 'rename.tag']));
  assert.match(table, /\| Scenario \| vscode minimum \| webstorm installed \|/u);
  assert.match(table, /\| `rename\.tag` \| \*\*fail\*\* \| n\/a \|/u);
  // The gap between the two editors is what the table is for, so the reason one of them
  // could not answer is in it.
  assert.match(table, /not answerable from outside the IDE/u);
});

void test('a failed scenario is a refusal, and an editor that answered nothing a warning', () => {
  const found = findings(reached());
  assert.equal(found.filter((one) => one.severity === 'error').length, 1);
  assert.match(String(found.find((one) => one.severity === 'error')?.message), /rename\.tag/u);

  const absent = findings([
    {
      adapter: 'webstorm',
      edition: 'installed',
      version: 'none',
      results: [{ id: 'session.start', status: 'unavailable', detail: 'no WebStorm found' }],
    },
  ]);
  assert.deepEqual(
    absent.map((one) => one.severity),
    ['warning'],
  );
});
