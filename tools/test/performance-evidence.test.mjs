import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { errors } from '../../cli/diagnostics/index.mjs';
import { REPO } from '../../cli/layout.mjs';
import { DIST_BASELINE, performanceEvidence, runsTheGate } from '../benchmark/evidence.mjs';
import { checkPerformanceGuide, readEvidence } from '../checks/performance-check.mjs';

/**
 * What a performance number is allowed to claim.
 *
 * The harness already decides whether a run failed. These tests are about the second
 * question, the one a reader asks: of the numbers this repository publishes, which are
 * held by something and which are merely true of one afternoon on one laptop. Each case
 * is a way that distinction was lost before the evidence module existed — a median from
 * an incomparable machine printed like any other, a workload nobody has run since it was
 * declared, a guide restating a baseline it no longer matched.
 *
 * @import { BaselineFile, WorkloadRecord } from '../benchmark/types.js'
 */

/** The page the generator owns. */
const TARGET = 'docs/guide/performance.md';

/**
 * @param {number} median
 * @returns {import('../benchmark/types.js').MetricStats}
 */
function stats(median) {
  return { median, p95: median, mean: median, min: median, max: median };
}

/** @type {WorkloadRecord} */
const RENDER = {
  id: 'collection/table-sort-10000',
  suite: 'collection',
  title: 'Sort 10,000 records',
  units: { duration: 'ms' },
  samples: 20,
  warmup: 3,
  metrics: { duration: stats(17.4) },
};

/** @type {WorkloadRecord} */
const ARTIFACT = {
  id: 'delivery/artifact-size',
  suite: 'delivery',
  title: 'Verified production artifact size',
  units: { chainDepth: 'depth', gzipBytes: 'artifact-bytes' },
  samples: 1,
  warmup: 0,
  metrics: { chainDepth: stats(3), gzipBytes: stats(154_273) },
};

/**
 * @param {readonly WorkloadRecord[]} results
 * @returns {BaselineFile}
 */
function baseline(results) {
  return {
    version: 2,
    recorded: '2026-08-31T09:42:58.466Z',
    mode: 'ci',
    app: 'example',
    environment: {
      profile: 'fixture',
      platform: 'Darwin',
      release: '25.6.0',
      arch: 'arm64',
      cpu: 'Apple M3',
      cores: 8,
      memoryGiB: 16,
      node: 'v22.14.0',
      chrome: 'Chrome/151.0.7922.175',
      dependencies: { lit: '3.3.3' },
    },
    calibration: {
      readings: 8,
      overall: { arithmetic: 23.7, layout: 21 },
      bySuite: {},
      spread: { arithmetic: 1.05, layout: 1.02 },
    },
    results: [...results],
  };
}

/** @param {readonly WorkloadRecord[]} results */
function declared(results) {
  return results.map((record) => ({
    id: record.id,
    suite: record.suite,
    title: record.title,
    driver: /** @type {const} */ ('browser'),
    samples: { local: 20, ci: 20 },
    warmup: { local: 3, ci: 3 },
  }));
}

/**
 * @param {Partial<Parameters<typeof performanceEvidence>[0]>} [overrides]
 */
function evidenceOf(overrides = {}) {
  const results = [RENDER, ARTIFACT];
  return performanceEvidence({
    origin: 'source',
    from: 'tools/benchmark/baseline.json',
    file: baseline(results),
    declared: declared(results),
    inGate: new Set(results.map((record) => record.id)),
    pending: [{ id: 'collection/typeahead', reason: 'the stub is undecided' }],
    product: { 'delivery/artifact-size': { chainDepth: 3 } },
    environmentIndependent: ['delivery/artifact-size'],
    ...overrides,
  });
}

void test('a measured median is gated, and says what holds it', () => {
  const evidence = evidenceOf();
  const claim = evidence.claims.find((entry) => entry.id === 'collection/table-sort-10000');

  assert.equal(claim?.standing, 'gated');
  assert.equal(claim?.primary, true);
  assert.match(String(claim?.basis), /regresses/u);
  assert.equal(evidence.gate.gated, 2);
});

void test('an absolute product budget is a limit rather than a comparison', () => {
  const claim = evidenceOf().claims.find((entry) => entry.metric === 'chainDepth');

  assert.equal(claim?.standing, 'limited');
  assert.equal(claim?.limit, 3);
  assert.match(String(claim?.basis), /any machine/u);
});

void test('an incomparable run may not be quoted as proved', () => {
  const evidence = evidenceOf({
    comparable: false,
    reason: 'the baseline was recorded on another machine',
  });

  const timed = evidence.claims.find((entry) => entry.id === 'collection/table-sort-10000');
  assert.equal(timed?.standing, 'reported', 'a timing from an incomparable machine gates nothing');
  assert.equal(timed?.basis, 'the baseline was recorded on another machine');
  assert.equal(evidence.gate.comparable, false);

  // Deterministic inventory does not become incomparable because the host was busy, and
  // an absolute limit is compared raw on any machine. Both stay proved.
  const depth = evidence.claims.find((entry) => entry.metric === 'chainDepth');
  const bytes = evidence.claims.find((entry) => entry.metric === 'gzipBytes');
  assert.equal(depth?.standing, 'limited');
  assert.equal(bytes?.standing, 'gated');
});

void test('an absolute limit on an unmeasured workload still shows as a limit', () => {
  const evidence = evidenceOf({
    product: {
      'delivery/artifact-size': { chainDepth: 3 },
      'editor/edit-burst': { validations: 1 },
    },
  });

  const held = evidence.gate.limits.find((limit) => limit.id === 'delivery/artifact-size');
  const empty = evidence.gate.limits.find((limit) => limit.id === 'editor/edit-burst');
  assert.equal(held?.recorded, 3);
  assert.equal(empty?.recorded, null, 'a limit nothing measured holds nothing, and says so');
  assert.equal(empty?.unit, null);
});

void test('a declared workload nothing measured is a gap, not a silence', () => {
  const results = [RENDER];
  const evidence = performanceEvidence({
    origin: 'source',
    from: 'tools/benchmark/baseline.json',
    file: baseline(results),
    declared: declared([RENDER, ARTIFACT]),
    inGate: new Set([RENDER.id, ARTIFACT.id]),
    pending: [],
  });

  assert.deepEqual(
    evidence.coverage.unmeasured.map((gap) => gap.id),
    ['delivery/artifact-size'],
  );
  assert.equal(
    evidence.claims.some((claim) => claim.id === 'delivery/artifact-size'),
    false,
    'a workload with no record may not produce a claim',
  );
});

void test('a workload a file was never meant to carry is unrecorded, not missing', () => {
  const evidence = performanceEvidence({
    origin: 'dist',
    from: 'benchmark/artifact-baseline.json',
    file: baseline([ARTIFACT]),
    declared: declared([RENDER, ARTIFACT]),
    inGate: new Set([RENDER.id, ARTIFACT.id]),
    pending: [],
    recorded: DIST_BASELINE,
  });

  assert.deepEqual(evidence.coverage.unmeasured, []);
  assert.deepEqual(
    evidence.coverage.outsideGate.map((gap) => [gap.id, gap.kind]),
    [['collection/table-sort-10000', 'unrecorded']],
  );
});

void test('a recorded workload the registry dropped is reported as undeclared', () => {
  const evidence = performanceEvidence({
    origin: 'source',
    from: 'tools/benchmark/baseline.json',
    file: baseline([RENDER, ARTIFACT]),
    declared: declared([ARTIFACT]),
    inGate: new Set([ARTIFACT.id]),
    pending: [],
  });

  assert.deepEqual(
    evidence.coverage.undeclared.map((gap) => gap.id),
    ['collection/table-sort-10000'],
  );
});

void test('pending workloads travel with the claims rather than beside them', () => {
  assert.deepEqual(
    evidenceOf().coverage.pending.map((gap) => gap.id),
    ['collection/typeahead'],
  );
});

void test('nothing measured is nothing claimed', () => {
  const evidence = performanceEvidence({
    origin: 'source',
    from: 'tools/benchmark/baseline.json',
    file: null,
    declared: declared([RENDER]),
    inGate: new Set([RENDER.id]),
    pending: [],
  });

  assert.deepEqual(evidence.claims, []);
  assert.equal(evidence.provenance, null);
  assert.equal(evidence.gate.comparable, false);
});

void test('whether the gate runs on its own is read, not assumed', () => {
  assert.equal(runsTheGate('      - run: npm run check\n'), false);
  assert.equal(runsTheGate('      - run: npm run benchmark:ci\n'), true);
  assert.equal(runsTheGate('      - run: node tools/benchmark/run.mjs --ci\n'), true);
});

void test('this repository states that nothing automated runs the gate', async () => {
  const documents = await readEvidence();
  const source = documents.find((evidence) => evidence.origin === 'source');

  assert.equal(
    source?.gate.automated,
    false,
    'a workflow that runs the benchmark makes this claim false: regenerate the guide',
  );
});

void test('the committed performance guide agrees with the recorded baselines', async () => {
  const { diagnostics, drifted } = await checkPerformanceGuide();

  assert.deepEqual(drifted, [], 'run `npm run docs:performance:write` and commit the result');
  assert.deepEqual(
    errors(diagnostics).map((diagnostic) => diagnostic.code),
    [],
  );
});

void test('a hand-edited performance number is reported as drift', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'performance-check-'));
  const file = join(dir, 'performance.md');
  const text = await readFile(join(REPO, TARGET), 'utf8');
  await writeFile(file, text.replace(/\| 84\.6 ms \|/u, '| 42.0 ms |'), 'utf8');

  const { diagnostics, drifted } = await checkPerformanceGuide({ file });

  assert.ok(
    drifted.includes('performance-envelope') || drifted.includes('performance-facts'),
    `expected a generated performance table to drift, got ${drifted.join(', ')}`,
  );
  const drift = errors(diagnostics).find(
    (diagnostic) => diagnostic.code === 'docs/generated-drift',
  );
  assert.match(String(drift?.message), /docs:performance:write/u);
});
