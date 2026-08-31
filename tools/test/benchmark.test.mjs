import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { launchBrowser } from '../benchmark/browser.mjs';
import { requestChain, until } from '../benchmark/chain.mjs';
import {
  BASELINE_VERSION,
  DURATION,
  REFERENCE_FOR_SUITE,
  WorkloadFailure,
  aggregate,
  comparability,
  compare,
  failures,
  summarise,
  summariseCalibration,
  unstableReference,
} from '../benchmark/measure.mjs';
import { MEMORY_WORKLOADS } from '../benchmark/node/lifecycle.mjs';
import { STARTUP_STEPS, artifactWorkloads } from '../benchmark/node/startup.mjs';
import { HARNESS_PATH, startOrigin } from '../benchmark/origin.mjs';
import { PENDING, WORKLOADS, selectWorkloads } from '../benchmark/workloads.mjs';
import { REPO, readText } from '../../cli/layout.mjs';
import { extractImportMap } from '../../cli/package/interface.mjs';

/**
 * The benchmark harness's own tests: not "is the framework fast", but "would this
 * harness notice if it were not".
 *
 * Every one of these is a failure mode a benchmark suite has in practice. A workload
 * that renders the wrong thing and reports a fast time. A comparison against a
 * baseline from a different machine. A missing browser reported as an empty pass. A
 * leak check that only looks at the last measurement and therefore cannot see a
 * leak. They are unit tests because each of those has a decision behind it that can
 * be made wrong in one line.
 *
 * No Chrome is launched except by the one test that asserts a missing Chrome fails
 * clearly, and that one launches nothing: it points the launcher at a path that does
 * not exist.
 */

/** @import { BenchmarkSample, CalibrationRecord, WorkloadSpec } from '../benchmark/types.js' */

/** @type {WorkloadSpec} */
const SPEC = {
  id: 'fixture/workload',
  suite: 'template',
  title: 'a fixture',
  driver: 'browser',
  samples: { local: 3, ci: 2 },
  warmup: { local: 1, ci: 1 },
};

/** A workload of the same shape in a suite scaled by the other reference. */
/** @type {WorkloadSpec} */
const TOOLING_SPEC = { ...SPEC, id: 'fixture/tooling', suite: 'tooling' };

/**
 * @param {number} arithmetic
 * @param {number} layout
 * @returns {CalibrationRecord}
 */
function calibrationOf(arithmetic, layout) {
  const reading = { arithmetic, layout };
  return {
    readings: 2,
    overall: reading,
    bySuite: { template: reading, tooling: reading },
    spread: { arithmetic: 1, layout: 1 },
  };
}

/**
 * @param {{ profile: string, calibration?: CalibrationRecord, version?: number, results: import('../benchmark/types.js').WorkloadRecord[] }} input
 * @returns {import('../benchmark/types.js').BaselineFile}
 */
function baselineWith(input) {
  return {
    version: input.version ?? BASELINE_VERSION,
    recorded: '2026-01-01T00:00:00.000Z',
    mode: 'ci',
    app: 'example',
    environment: {
      profile: input.profile,
      platform: 'Darwin',
      release: '25.6.0',
      arch: 'arm64',
      cpu: 'Apple M3',
      cores: 8,
      memoryGiB: 16,
      node: process.version,
      chrome: '150',
      dependencies: {},
    },
    calibration: input.calibration ?? calibrationOf(100, 100),
    results: input.results,
  };
}

void test('a wrong answer fails the workload however fast it was', () => {
  /** @type {BenchmarkSample[]} */
  const samples = [
    { duration: 0.1, ok: true },
    { duration: 0.1, ok: false, detail: 'rendered 50 rows, expected 500' },
  ];

  assert.throws(
    () => aggregate(SPEC, samples, { warmup: 1 }),
    (error) =>
      error instanceof WorkloadFailure && /rendered 50 rows, expected 500/u.test(error.message),
  );
});

void test('a workload with no samples or no metric is a failure, not an empty pass', () => {
  assert.throws(() => aggregate(SPEC, [], { warmup: 0 }), WorkloadFailure);
  assert.throws(() => aggregate(SPEC, [{ ok: true }], { warmup: 0 }), WorkloadFailure);
  assert.throws(
    () => aggregate(SPEC, [{ ok: true, metrics: { heap: Number.NaN } }], { warmup: 0 }),
    WorkloadFailure,
  );
});

void test('sample count, warmup count and every metric survive aggregation', () => {
  const record = aggregate(
    SPEC,
    [
      { duration: 10, ok: true, metrics: { cells: 40_000 } },
      { duration: 12, ok: true, metrics: { cells: 40_000 } },
      { duration: 30, ok: true, metrics: { cells: 40_000 } },
    ],
    { warmup: 2 },
  );

  assert.equal(record.samples, 3);
  assert.equal(record.warmup, 2);
  assert.equal(record.metrics[DURATION]?.median, 12);
  assert.equal(record.metrics.cells?.median, 40_000);
});

void test('p95 is a sample that happened, not an interpolation', () => {
  // Nearest-rank throughout: with ten samples the median is the fifth of them, not
  // the average of the fifth and sixth, which is a number no run produced.
  const stats = summarise([1, 2, 3, 4, 5, 6, 7, 8, 9, 100]);
  assert.equal(stats.median, 5);
  assert.equal(stats.p95, 100);
  assert.equal(stats.max, 100);
  assert.equal(stats.min, 1);
});

void test('a regression past the threshold fails, and a different machine does not', () => {
  const current = [
    aggregate(SPEC, [{ duration: 13, ok: true }], { warmup: 0 }),
  ];
  const baseline = baselineWith({
    profile: 'other-machine',
    results: [aggregate(SPEC, [{ duration: 10, ok: true }], { warmup: 0 })],
  });

  const failing = compare(current, baseline, { threshold: 0.2, comparable: true });
  assert.equal(failing[0]?.status, 'regressed');
  assert.equal(failures(failing).length, 1);

  const incomparable = compare(current, baseline, { threshold: 0.2, comparable: false });
  assert.equal(incomparable[0]?.status, 'incomparable');
  assert.equal(failures(incomparable).length, 0, 'a foreign baseline must not fail a run');
});

void test('deterministic artifact inventory compares across environment profiles', () => {
  const artifact = {
    ...SPEC,
    id: 'delivery/artifact-size',
    suite: /** @type {'delivery'} */ ('delivery'),
    units: { rawBytes: 'artifact-bytes' },
  };
  const baseline = baselineWith({
    profile: 'other-machine',
    results: [aggregate(artifact, [{ ok: true, metrics: { rawBytes: 100 } }], { warmup: 0 })],
  });
  const current = [
    aggregate(artifact, [{ ok: true, metrics: { rawBytes: 120 } }], { warmup: 0 }),
  ];

  const comparisons = compare(current, baseline, {
    threshold: 0.1,
    comparable: false,
    environmentIndependent: ['delivery/artifact-size'],
  });
  assert.equal(comparisons[0]?.status, 'regressed');
});

void test('a large relative change that is a small absolute one cannot fail a run', () => {
  // The 0.1 ms workload that reports 0.2 ms on the next run: +100%, and meaningless.
  const baseline = baselineWith({
    profile: 'same',
    results: [aggregate(SPEC, [{ duration: 0.1, ok: true }], { warmup: 0 })],
  });

  const tick = compare([aggregate(SPEC, [{ duration: 0.2, ok: true }], { warmup: 0 })], baseline, {
    threshold: 0.2,
    minDelta: { ms: 1 },
  });
  assert.equal(tick[0]?.status, 'within-slack');
  assert.equal(failures(tick).length, 0);

  const real = compare([aggregate(SPEC, [{ duration: 30, ok: true }], { warmup: 0 })], baseline, {
    threshold: 0.2,
    minDelta: { ms: 1 },
  });
  assert.equal(real[0]?.status, 'regressed');
  assert.equal(failures(real).length, 1);
});

void test('an absolute product budget fails independently of any baseline', () => {
  const current = [aggregate(SPEC, [{ duration: 700, ok: true }], { warmup: 0 })];
  const comparisons = compare(current, null, {
    threshold: 0.2,
    product: { 'fixture/workload': { duration: 600 } },
  });
  assert.equal(comparisons[0]?.status, 'over-budget');
  assert.equal(failures(comparisons).length, 1);
});

void test('each suite is scaled by the reference its own work resembles', () => {
  // The measured failure this exists for: a machine whose renderer got 30% slower while
  // its arithmetic stayed put. Every page-side workload has to absorb that; the tooling
  // suite, which runs child processes, must not be scaled by a renderer figure.
  const baseline = baselineWith({
    profile: 'same',
    results: [
      aggregate(SPEC, [{ duration: 10, ok: true }], { warmup: 0 }),
      aggregate(TOOLING_SPEC, [{ duration: 10, ok: true }], { warmup: 0 }),
    ],
  });

  const { comparable, speedBySuite } = comparability({
    baseline,
    profile: 'same',
    calibration: calibrationOf(100, 130),
    maxSpeedDrift: 2,
    maxRunSpread: 1.25,
  });
  assert.equal(comparable, true, 'a 1.3x renderer is still the same machine');
  assert.equal(speedBySuite.template, 1.3);
  assert.equal(speedBySuite.tooling, 1);

  const comparisons = compare(
    [
      aggregate(SPEC, [{ duration: 13, ok: true }], { warmup: 0 }),
      aggregate(TOOLING_SPEC, [{ duration: 13, ok: true }], { warmup: 0 }),
    ],
    baseline,
    { threshold: 0.2, minDelta: { ms: 1 }, speedBySuite },
  );

  assert.equal(comparisons[0]?.status, 'ok', 'a render workload tracks the layout reference');
  assert.equal(comparisons[1]?.status, 'regressed', 'a tooling workload is not scaled by it');
});

void test('a machine that changed while the run was measured reports instead of failing', () => {
  const baseline = baselineWith({
    profile: 'same',
    results: [aggregate(SPEC, [{ duration: 10, ok: true }], { warmup: 0 })],
  });

  const moved = comparability({
    baseline,
    profile: 'same',
    calibration: { ...calibrationOf(100, 100), spread: { arithmetic: 1.02, layout: 1.4 } },
    maxSpeedDrift: 2,
    maxRunSpread: 1.25,
  });
  assert.equal(moved.comparable, false);
  assert.match(String(moved.reason), /layout reference moved 1\.40x between suites/u);

  const different = comparability({
    baseline,
    profile: 'same',
    calibration: calibrationOf(100, 260),
    maxSpeedDrift: 2,
    maxRunSpread: 1.25,
  });
  assert.equal(different.comparable, false);
  assert.match(String(different.reason), /2\.60x the baseline's/u);

  // The same rule stops `--update-baseline` recording from such a run, which is the
  // worse half of the failure: a spike baked into a baseline reads as an improvement in
  // every run after it.
  assert.deepEqual(
    unstableReference({ ...calibrationOf(100, 100), spread: { arithmetic: 1.02, layout: 1.4 } }, 1.25),
    { kind: 'layout', spread: 1.4 },
  );
  assert.equal(unstableReference(calibrationOf(100, 100), 1.25), null);

  const stale = comparability({
    baseline: { ...baseline, version: 1 },
    profile: 'same',
    calibration: calibrationOf(100, 100),
    maxSpeedDrift: 2,
    maxRunSpread: 1.25,
  });
  assert.equal(stale.comparable, false);
  assert.match(String(stale.reason), /version 1 file/u);
});

void test('calibration keeps every reading, per suite, with the spread between them', () => {
  const calibration = summariseCalibration([
    { suite: 'template', arithmetic: 24, layout: 20 },
    { suite: 'collection', arithmetic: 25, layout: 30 },
    { suite: 'tooling', arithmetic: 26, layout: 25 },
  ]);

  assert.equal(calibration.readings, 3, 'how many readings the medians came from');
  assert.equal(calibration.overall.arithmetic, 25, 'the median reading, not the first');
  assert.equal(calibration.bySuite.collection?.layout, 30, 'each suite keeps its own reading');
  assert.equal(calibration.spread.layout, 1.5, '30 ms against 20 ms is a machine that moved');
  assert.ok(calibration.spread.arithmetic < 1.1);

  // Every suite needs a reference kind, or a workload in it would be compared unscaled
  // without anything saying so.
  for (const workload of WORKLOADS) {
    assert.ok(
      REFERENCE_FOR_SUITE[workload.suite] !== undefined,
      `suite ${workload.suite} has no reference workload`,
    );
  }
});

/**
 * @param {string} url
 * @param {string | null} initiator
 * @param {number} [startedAt]
 * @returns {import('../benchmark/types.js').RequestRecord}
 */
function request(url, initiator, startedAt = 0) {
  return {
    url,
    type: 'Script',
    status: 200,
    encodedBytes: 0,
    fromCache: false,
    startedAt,
    initiator: { type: initiator === null ? 'other' : 'script', url: initiator },
  };
}

void test('a serial chain and a flat one of the same size are told apart', () => {
  // The failure this exists for: both of these are five requests and zero bytes, so
  // the count and the byte total report them as the same load.
  const serial = [
    request('/', null),
    request('/entry.js', '/'),
    request('/root.js', '/entry.js'),
    request('/shell.js', '/root.js'),
    request('/page.js', '/shell.js'),
  ];
  const flat = [
    request('/', null),
    request('/entry.js', '/'),
    request('/root.js', '/'),
    request('/shell.js', '/'),
    request('/page.js', '/'),
  ];

  assert.equal(serial.length, flat.length);
  assert.deepEqual(requestChain(serial), {
    depth: 5,
    path: ['/', '/entry.js', '/root.js', '/shell.js', '/page.js'],
  });
  assert.equal(requestChain(flat).depth, 2);
});

void test('a chain stops at the first routed view, and cycles do not hang it', () => {
  const load = [
    request('/', null, 1000),
    request('/entry.js', '/', 1010),
    // A resource() from onMount: after the view, and not part of reaching it.
    request('/api/projects', '/entry.js', 1400),
  ];
  assert.equal(requestChain(load).depth, 3);
  assert.equal(requestChain(until(load, 1200)).depth, 2);

  assert.equal(
    requestChain([request('/a.js', '/b.js'), request('/b.js', '/a.js')]).depth,
    2,
    'a cycle is walked once, not forever',
  );
});

void test('a new workload is reported as new rather than passed or failed', () => {
  const comparisons = compare(
    [aggregate(SPEC, [{ duration: 1, ok: true }], { warmup: 0 })],
    null,
    { threshold: 0.2 },
  );
  assert.equal(comparisons[0]?.status, 'new');
  assert.equal(failures(comparisons).length, 0);
});

void test('a leaked listener is detected by the lifecycle workload, and steady state is not', async () => {
  const workload = MEMORY_WORKLOADS.find((entry) => entry.id === 'memory/route-cycles');
  assert.ok(workload?.run !== undefined);

  /**
   * A page that answers the cycle call correctly and reports whatever counters the
   * test wants. Everything else about the workload — batching, the correctness
   * expectation, the growth rule — is the real code.
   *
   * @param {readonly number[]} listeners
   * @returns {import('../benchmark/types.js').NodeWorkloadContext}
   */
  const contextWith = (listeners) => {
    let batch = 0;
    /** @type {import('../benchmark/types.js').BenchmarkPage} */
    const page = {
      goto: () => Promise.resolve(),
      evaluate: () =>
        Promise.resolve(
          /** @type {never} */ (/** @type {unknown} */ ({ navigations: 20, leftBehind: 0 })),
        ),
      heap: () => Promise.resolve(1_000_000),
      retained: () => {
        const value = listeners[Math.min(batch, listeners.length - 1)] ?? 0;
        batch += 1;
        return Promise.resolve({ nodes: 500, listeners: value });
      },
      requests: () => [],
      offOrigin: () => [],
      reset: () => undefined,
      errors: () => [],
      close: () => Promise.resolve(),
    };

    return {
      mode: 'ci',
      samples: 1,
      warmup: 0,
      app: { name: 'example', dir: REPO },
      repo: REPO,
      origin: { url: 'http://127.0.0.1:0', close: () => Promise.resolve() },
      browser: {
        version: 'fixture',
        harnessPage: () => Promise.resolve(page),
        load: () => Promise.resolve(page),
        close: () => Promise.resolve(),
      },
    };
  };

  // Six readings: one baseline before any batch, then one per batch.
  const leaking = await workload.run(contextWith([100, 140, 180, 220, 260, 300]));
  assert.equal(leaking[0]?.ok, false);
  assert.match(String(leaking[0]?.detail), /retained listeners grew in every batch/u);

  const steady = await workload.run(contextWith([100, 104, 103, 105, 104, 106]));
  assert.equal(steady[0]?.ok, true, String(steady[0]?.detail));
});

void test('a missing Chrome fails clearly instead of reporting no results', async () => {
  const previous = process.env.CHROME_PATH;
  try {
    process.env.CHROME_PATH = '';
    await assert.rejects(
      () => launchBrowser({ originUrl: 'http://127.0.0.1:1' }),
      /No Chrome installation was found/u,
    );

    process.env.CHROME_PATH = fileURLToPath(new URL('./no-such-chrome', import.meta.url));
    await assert.rejects(
      () => launchBrowser({ originUrl: 'http://127.0.0.1:1' }),
      /could not be launched/u,
    );
  } finally {
    if (previous === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = previous;
  }
});

void test('the measured origin serves the application own import map, hashed into its CSP', async () => {
  const origin = await startOrigin({ name: 'example', dir: `${REPO}/example` });
  try {
    const response = await fetch(`${origin.url}${HARNESS_PATH}`);
    const html = await response.text();
    const { body: served } = extractImportMap(html, 'the harness page');
    const { body: expected } = extractImportMap(
      await readText(`${REPO}/example/index.html`),
      'example/index.html',
    );
    assert.equal(served, expected, 'the harness map must be the application map, not a copy');

    const csp = /content="([^"]+)"/u.exec(html)?.[1] ?? '';
    assert.match(csp, /script-src 'self' 'sha256-/u, 'an inline import map needs its hash in CSP');
    assert.match(csp, /trusted-types lit-html ui-test ui-test-template;/u);
    assert.doesNotMatch(csp, /test-harness/u, 'the benchmark has no fixture policy');
    assert.doesNotMatch(csp, /unsafe-eval/u);
  } finally {
    await origin.close();
  }
});

void test('the measured origin refuses to leave its mounts and keeps a missing module a 404', async () => {
  const origin = await startOrigin({ name: 'example', dir: `${REPO}/example` });
  try {
    const escape = await fetch(`${origin.url}/lib/../../../etc/passwd`, { redirect: 'manual' });
    assert.ok(escape.status === 403 || escape.status === 404, `got ${String(escape.status)}`);

    const missing = await fetch(`${origin.url}/src/not-a-module.js`, {
      headers: { accept: 'text/html' },
    });
    assert.equal(missing.status, 404, 'history fallback must not answer a missing module with HTML');

    const vendor = await fetch(`${origin.url}/lib/vendor/lit-all.min.js`);
    assert.equal(vendor.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    const module = await fetch(`${origin.url}/lib/core/navigation/router.js`);
    assert.equal(module.headers.get('cache-control'), 'no-cache');
  } finally {
    await origin.close();
  }
});

void test('the artifact origin serves production headers, compression, fallback and session', async () => {
  const publicDir = await mkdtemp(join(tmpdir(), 'ui-test-benchmark-artifact-'));
  const csp = "default-src 'self'; script-src 'self'";
  const immutable = 'public, max-age=31536000, immutable';
  const revalidate = 'private, no-cache';
  await mkdir(join(publicDir, 'assets'));
  await writeFile(join(publicDir, 'index.html'), '<!doctype html><title>artifact</title>');
  await writeFile(join(publicDir, 'app.manifest.json'), '{}\n');
  await writeFile(join(publicDir, 'assets', 'app-deadbeef.js'), `export default ${'1'.repeat(2048)};\n`);

  const origin = await startOrigin(
    { name: 'example', dir: `${REPO}/example` },
    {
      artifact: {
        publicDir,
        csp,
        cache: { immutable, revalidate },
        assets: ['/assets/app-deadbeef.js'],
      },
    },
  );
  try {
    const entry = await fetch(`${origin.url}/money`, { headers: { accept: 'text/html' } });
    assert.equal(entry.status, 200);
    assert.equal(entry.headers.get('content-security-policy'), csp);
    assert.equal(entry.headers.get('cache-control'), revalidate);
    assert.match(await entry.text(), /<title>artifact<\/title>/u);

    const asset = await fetch(`${origin.url}/assets/app-deadbeef.js`);
    assert.equal(asset.headers.get('cache-control'), immutable);
    assert.equal(asset.headers.get('content-encoding'), 'gzip');
    assert.ok(Number(asset.headers.get('content-length')) < 512, 'gzip transfer must be smaller');

    const release = origin.switchRelease?.(['/assets/app-deadbeef.js']);
    assert.ok(release !== undefined, 'artifact origin exposes its release switch simulation');
    const retained = await fetch(`${origin.url}/assets/app-deadbeef.js`);
    assert.equal(retained.status, 200, 'old hash stays readable after publication switches');
    assert.deepEqual(release.retainedRequests(), ['/assets/app-deadbeef.js']);
    release.restore();
    assert.throws(
      () => origin.switchRelease?.(['/assets/not-reported.js']),
      /Cannot replace unreported artifact asset/u,
    );

    const manifest = await fetch(`${origin.url}/app.manifest.json`);
    assert.equal(manifest.headers.get('cache-control'), revalidate);

    const session = await fetch(`${origin.url}/auth/session`);
    assert.equal(session.status, 401);
    assert.equal(session.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await session.json(), { error: 'no_session' });
  } finally {
    await origin.close();
    await rm(publicDir, { recursive: true, force: true });
  }
});

void test('artifact size workload reports verified payload categories without rebuilding', async () => {
  // Built from a fixture declaration rather than from the example's: the workload's job
  // — read a verified report, report its payload categories — does not depend on which
  // application declared it, and a fixture keeps this case from moving when the
  // example's own declaration does.
  const workload = artifactWorkloads({
    app: 'fixture',
    lazyRoutes: [],
  }).find((entry) => entry.id === 'delivery/artifact-size');
  assert.ok(workload?.run !== undefined);
  const files = [
    {
      path: 'public/assets/entry-deadbeef.js',
      cache: 'immutable',
      bytes: 100,
      gzip: 60,
      brotli: 50,
      sha256: 'a'.repeat(64),
    },
    {
      path: 'public/assets/index-deadbeef.css',
      cache: 'immutable',
      bytes: 80,
      gzip: 40,
      brotli: 30,
      sha256: 'b'.repeat(64),
    },
    {
      path: 'public/assets/templates-deadbeef.json',
      cache: 'immutable',
      bytes: 120,
      gzip: 50,
      brotli: 40,
      sha256: 'c'.repeat(64),
    },
  ];
  const samples = await workload.run(
    /** @type {import('../benchmark/types.js').NodeWorkloadContext} */ (
      /** @type {unknown} */ ({
        artifact: {
          root: '/fixture',
          report: {
            app: 'example',
            totals: { files: 3, bytes: 300, gzip: 150, brotli: 120 },
            chunks: [],
            chain: { depth: 3, path: ['a.js', 'b.js', 'c.js'] },
            files,
          },
        },
      })
    ),
  );

  assert.deepEqual(samples, [
    {
      ok: true,
      metrics: {
        files: 3,
        chainDepth: 3,
        rawBytes: 300,
        gzipBytes: 150,
        brotliBytes: 120,
        javascriptRawBytes: 100,
        javascriptGzipBytes: 60,
        cssRawBytes: 80,
        cssGzipBytes: 40,
        templateRawBytes: 120,
        templateGzipBytes: 50,
      },
    },
  ]);
});

void test('every startup step the runtime publishes is a declared metric', async () => {
  // The harness reads the page's performance timeline, so it cannot discover a step the
  // runtime added: an unlisted step is measured by the browser, reported by nobody and
  // gated by nothing. This is the only place the two lists meet. ADR-0084.
  const types = await readFile(`${REPO}/source/lib/core/application/types.d.ts`, 'utf8');
  const union = /export type StartupStep =([^;]+);/u.exec(types)?.[1];
  assert.ok(union !== undefined, 'the runtime must still declare its steps as a union');
  const declared = [...union.matchAll(/'([a-z]+)'/gu)].map((match) => match[1]);
  assert.ok(declared.length > 0);
  assert.deepEqual(
    [...STARTUP_STEPS].sort(),
    [...declared].sort(),
    'the benchmark step list and the runtime step union must name the same steps',
  );
});

void test('the ci profile is bounded and declares what it does not cover', async () => {
  /** @type {import('../benchmark/types.js').BudgetFile} */
  const budgets = JSON.parse(await readFile(`${REPO}/tools/benchmark/budgets.json`, 'utf8'));
  assert.ok(budgets.ciMaxSeconds > 0, 'the gate needs a wall-clock ceiling');
  assert.ok(budgets.regressionThreshold > 0 && budgets.regressionThreshold < 1);
  assert.ok(budgets.maxRunSpread > 1, 'a run needs a limit on how far the machine may move');
  assert.ok(budgets.maxSpeedDrift > 1);
  // Absolute limits stay scarce and stay explained. The one that exists is a count of
  // round trips rather than a duration, which is why it needs neither the machine
  // scaling nor the noise slack an absolute timing would. ADR-0082.
  assert.deepEqual(
    budgets.product,
    { 'delivery/artifact-size': { chainDepth: 3 } },
    'a product budget is a decision, and only the chain-depth one has been taken',
  );
  assert.equal(budgets.minDelta?.depth, 1, 'a single added serial hop has to be a regression');

  const ci = selectWorkloads('ci', {});
  assert.ok(ci.length > 0);
  assert.ok(ci.every((workload) => workload.localOnly !== true));

  // The example ships a benchmark.json, so the artifact workloads its declaration names
  // are selected — which is what makes the chain-depth product budget above reachable at
  // all. An application's route names reach its own numbers and nothing else, which is
  // the property the declaration seam exists to hold.
  const distExample = selectWorkloads('ci', { app: 'example', origin: 'dist' });
  assert.ok(
    distExample.some((workload) => workload.id === 'delivery/artifact-size'),
    'the application that declares an artifact must produce the size workload',
  );
  assert.ok(
    distExample.some((workload) => workload.id.startsWith('delivery/lazy-')),
    'the declared lazy routes must each produce a workload',
  );
  assert.ok(
    selectWorkloads('ci', { app: 'example', origin: 'source' }).every(
      (workload) =>
        workload.id !== 'delivery/artifact-size' && !workload.id.startsWith('delivery/lazy-'),
    ),
    'artifact workloads need the dist origin and must not select on the source one',
  );
  // And an application that declares nothing still contributes nothing: the seam is the
  // declaration, not the presence of an application directory.
  assert.deepEqual(
    selectWorkloads('ci', { app: 'no-such-application', origin: 'dist' }).filter(
      (workload) => workload.suite === 'delivery' && workload.id !== 'delivery/entry-route',
    ),
    [],
  );

  const ids = new Set(WORKLOADS.map((workload) => workload.id));
  assert.equal(ids.size, WORKLOADS.length, 'workload ids must be unique');
  for (const suite of ['startup', 'template', 'router', 'collection', 'memory', 'delivery', 'tooling']) {
    assert.ok(
      WORKLOADS.some((workload) => workload.suite === suite),
      `no workload covers the ${suite} suite`,
    );
  }

  for (const pending of PENDING) {
    assert.ok(!ids.has(pending.id), `${pending.id} is listed as pending but also implemented`);
    assert.ok(pending.reason.length > 40, 'a pending workload states why, for the next agent');
  }
});

void test('the checked-in baseline carries what a comparison needs', async () => {
  /** @type {import('../benchmark/types.js').BaselineFile} */
  const baseline = JSON.parse(await readFile(`${REPO}/tools/benchmark/baseline.json`, 'utf8'));

  assert.equal(baseline.version, BASELINE_VERSION);
  assert.equal(baseline.mode, 'ci', 'the gate compares against a ci-profile baseline');
  const env = baseline.environment;
  for (const field of [env.profile, env.platform, env.arch, env.cpu, env.node, env.chrome]) {
    assert.ok(field.length > 0, 'every environment field a profile is built from must be recorded');
  }
  assert.ok(env.cores > 0 && env.memoryGiB > 0);
  assert.ok(Object.keys(env.dependencies).length > 0, 'runtime versions belong to the result');

  // A baseline recorded on a machine that was moving would misreport every run after it,
  // so the file itself is checked rather than only the code that refuses to write one.
  assert.ok(baseline.calibration.readings >= 2);
  assert.ok(baseline.calibration.overall.layout > 0 && baseline.calibration.overall.arithmetic > 0);
  assert.equal(unstableReference(baseline.calibration, 1.25), null);

  assert.ok(baseline.results.length > 0);
  for (const record of baseline.results) {
    assert.ok(record.samples > 0, `${record.id} recorded no sample count`);
    assert.ok(Object.keys(record.metrics).length > 0, `${record.id} recorded no metric`);
  }
});
