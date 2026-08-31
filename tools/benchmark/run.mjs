/**
 * The benchmark runner.
 *
 *   node tools/benchmark/run.mjs [--ci] [--app example] [--suite router,table]
 *                               [--only keyed] [--out path.json] [--update-baseline]
 *                               [--baseline path.json]
 *
 * `npm run benchmark` is the local, detailed profile: more samples, every workload.
 * `npm run benchmark:ci` is the gate: fewer samples, a bounded runtime, and a
 * non-zero exit when a median or p95 has regressed past the threshold in budgets.json
 * or an absolute product budget is exceeded.
 *
 * WHAT MAKES IT A GATE RATHER THAN A REPORT
 *
 *   1. A workload whose correctness check failed fails the run. Fast and wrong is
 *      not a result.
 *   2. A workload that could not run fails the run. In particular a missing Chrome
 *      is an environment failure that exits non-zero, never a suite that passed by
 *      running nothing.
 *   3. A comparison against a baseline from another machine is reported and not
 *      failed, because the alternative is a gate that fails for having a different
 *      CPU and gets switched off within a week.
 *   4. `--ci` has a wall-clock ceiling from budgets.json. Overrunning it fails, so
 *      the gate cannot grow into something nobody runs.
 *   5. A run that measured a machine which did not hold still is reported and not
 *      failed, and `--update-baseline` refuses to record from it. The reference
 *      readings taken before each suite are what decide that.
 *
 * Nothing here may change production behaviour, and no workload may be tuned to
 * look good. The only legitimate reason to touch a workload after seeing its number
 * is that the number was wrong. ADR-0037.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

import { REPO, selectedApp } from '../../cli/layout.mjs';
import { REPORT, isRemoteReport, readReport } from '../../cli/delivery/artifact-report.mjs';
import {
  BASELINE_VERSION,
  DURATION,
  WorkloadFailure,
  aggregate,
  comparability,
  compare,
  failures,
  summariseCalibration,
  unstableReference,
} from './measure.mjs';
import { describeEnvironment } from './environment.mjs';
import { launchBrowser } from './browser.mjs';
import { renderReport, writeResults } from './report.mjs';
import { startOrigin } from './origin.mjs';
import { PENDING, selectWorkloads } from './workloads.mjs';

/** @import { BaselineFile, BenchmarkPage, BenchmarkSample, BudgetFile, Mode, ReferenceReading, WorkloadRecord, WorkloadSpec } from './types.js' */

const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)));
const BASELINE = join(HERE, 'baseline.json');

/**
 * The dist-origin baseline is the application's, not the harness's: it records the
 * verified byte counts of one production artifact, which only that application can
 * produce. It therefore lives in the repository that owns the application —
 * `<repo>/benchmark/artifact-baseline.json` — and `--baseline` overrides both.
 */
const ARTIFACT_BASELINE = join(REPO, 'benchmark', 'artifact-baseline.json');
const BUDGETS = join(HERE, 'budgets.json');

/**
 * @param {string} name
 * @returns {string | undefined}
 */
function flag(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

/**
 * @param {string} name
 * @returns {string[] | undefined}
 */
function listFlag(name) {
  const value = flag(name);
  return value === undefined ? undefined : value.split(',').map((part) => part.trim());
}

/**
 * Run every selected workload, one at a time.
 *
 * Serially, always. Two workloads sharing a CPU produce two wrong numbers, and the
 * harness is not slow enough for the parallelism to be worth the loss.
 *
 * @returns {Promise<number>} process exit code
 */
async function main() {
  /** @type {Mode} */
  const mode = process.argv.includes('--ci') ? 'ci' : 'local';
  const app = await selectedApp();
  const originAdapter = flag('origin') ?? 'source';
  if (originAdapter !== 'source' && originAdapter !== 'dist') {
    console.error(`Unknown benchmark origin "${originAdapter}"; use source or dist.`);
    return 1;
  }
  const workloads = selectWorkloads(mode, {
    suites: listFlag('suite'),
    only: listFlag('only'),
    app: app.name,
    origin: originAdapter,
  });

  if (workloads.length === 0) {
    console.error('No workload matched the filters.');
    return 1;
  }

  /** @type {BudgetFile} */
  const budgets = JSON.parse(await readFile(BUDGETS, 'utf8'));
  const baselineFlag = flag('baseline');
  const baselinePath = baselineFlag ?? (originAdapter === 'dist' ? ARTIFACT_BASELINE : BASELINE);
  const baseline = await readBaseline(baselinePath);

  const artifact = originAdapter === 'dist' ? await readArtifactOrigin(app) : undefined;
  const origin = await startOrigin(app, { artifact });
  const browser = await launchBrowser({ originUrl: origin.url });
  const environment = await describeEnvironment({
    chrome: browser.version,
    // Source Space executes the vendored browser compiler. The artifact executes its
    // generated CSS, so carrying Tailwind into that environment fingerprint would say
    // the measured browser ran bytes it demonstrably did not request.
    excludeDependencies: originAdapter === 'dist' ? ['@tailwindcss/browser'] : [],
  });

  /** @type {WorkloadRecord[]} */
  const results = [];
  /** @type {{ id: string, reason: string }[]} */
  const failed = [];
  /** @type {({ suite: string } & ReferenceReading)[]} */
  const readings = [];
  const started = Date.now();

  // Nothing is measured until the reference workloads repeat, because the first thing a
  // freshly launched Chrome does is not representative of anything. Measured across two
  // back-to-back ci runs: the first reading of a run reported the layout reference at
  // 224 ms and 117 ms while the same reference two suites later reported 25 ms, and the
  // startup workloads that ran in between inherited every bit of that. A browser
  // starting its GPU and network processes, the previous run's compiler processes
  // exiting, and a page that has never laid out a box are all transients, and a
  // benchmark that measures them reports them as the framework's cost.
  const settling = await settle(browser, { attempts: 6, tolerance: 0.1 });
  process.stderr.write(
    `  machine settled after ${String(settling.attempts)} reference readings` +
      (settling.settled ? '\n' : ', or did not: readings kept moving more than 10%\n'),
  );

  try {
    /** @type {Set<string>} */
    const measured = new Set();

    for (const workload of workloads) {
      // A reference reading when each suite starts, on the same page machinery every
      // workload uses. Comparisons are scaled by it, so a laptop that warmed up between
      // the template suite and the collection suite stops reading as a repository-wide
      // regression — and one that moved too far to trust says so. One reading per
      // suite, not per contiguous block: the registry interleaves two suites whose
      // workloads share a module, and a second reading of the same suite would be a
      // reading nothing is compared against.
      if (!measured.has(workload.suite)) {
        measured.add(workload.suite);
        process.stderr.write(`  reference for ${workload.suite} ... `);
        const reading = await measureCalibration(browser);
        readings.push({ suite: workload.suite, ...reading });
        process.stderr.write(
          `arithmetic ${reading.arithmetic.toFixed(1)} ms, layout ${reading.layout.toFixed(1)} ms\n`,
        );
      }

      const samples = workload.samples[mode];
      const warmup = workload.warmup[mode];
      process.stderr.write(`  ${workload.id} ... `);

      try {
        const collected = await collect(workload, {
          mode,
          samples,
          warmup,
          app,
          repo: REPO,
          artifact:
            artifact === undefined
              ? undefined
              : { root: join(REPO, 'dist', app.name), report: artifact.report },
          origin,
          browser,
        });
        const record = aggregate(workload, collected, { warmup });
        results.push(record);
        const duration = record.metrics[DURATION];
        process.stderr.write(
          duration === undefined ? 'done\n' : `${duration.median.toFixed(2)} ms\n`,
        );
      } catch (cause) {
        const reason = cause instanceof WorkloadFailure ? cause.message : String(cause);
        failed.push({ id: workload.id, reason });
        process.stderr.write('FAILED\n');
      }
    }

    // A closing reading, so that the last suite measured is bracketed like every other
    // one and a single-suite run has two readings to disagree. Filed under the suite it
    // followed: `summariseCalibration` keeps each suite's own opening reading, and this
    // one exists to be compared with it rather than to scale anything.
    const last = readings.at(-1);
    if (last !== undefined) {
      const reading = await measureCalibration(browser);
      readings.push({ suite: last.suite, ...reading });
    }
  } finally {
    await browser.close();
    await origin.close();
  }

  const elapsedMs = Date.now() - started;
  const calibration = summariseCalibration(
    // A run that measured nothing still has to produce a record rather than crash on
    // an empty list: the failure it needs to report is the one that stopped it.
    readings.length > 0 ? readings : [{ suite: 'none', arithmetic: 0, layout: 0 }],
  );
  const { comparable, reason, speedBySuite } = comparability({
    baseline,
    profile: environment.profile,
    calibration,
    maxSpeedDrift: budgets.maxSpeedDrift,
    maxRunSpread: budgets.maxRunSpread,
  });
  const comparisons = compare(results, baseline, {
    threshold: budgets.regressionThreshold,
    suiteThresholds: budgets.suiteThresholds,
    minDelta: budgets.minDelta,
    product: budgets.product,
    comparable,
    speedBySuite,
    // Report inventory is deterministic and does not become incomparable because Chrome
    // or the host changed. Browser timings still obey the environment gate.
    environmentIndependent: ['delivery/artifact-size'],
  });

  console.log(
    renderReport({
      results,
      comparisons,
      environment,
      mode,
      app: originAdapter === 'dist' ? `${app.name}:dist` : app.name,
      elapsedMs,
      failures: failed,
      pending:
        originAdapter === 'dist'
          ? PENDING.filter((item) => item.id !== 'startup/templates-bundle')
          : PENDING,
      baseline,
      comparable,
      reason: gateReason(baseline, baselinePath, originAdapter, reason),
      calibration,
      speedBySuite,
    }),
  );

  /** @type {BaselineFile} */
  const file = {
    version: BASELINE_VERSION,
    recorded: new Date().toISOString(),
    mode,
    app: originAdapter === 'dist' ? `${app.name}:dist` : app.name,
    environment,
    calibration,
    results,
  };
  const baselineFile =
    originAdapter === 'dist'
      ? {
          ...file,
          // Dist timings remain evidence, not gates, until their sample policy is settled.
          // The first artifact baseline owns only deterministic inventory drift.
          results: results.filter((record) => record.id === 'delivery/artifact-size'),
        }
      : file;

  const out = flag('out');
  if (out !== undefined) await writeResults(resolve(out), file);

  // A baseline is the thing every later run is measured against, so it may not be
  // recorded on a machine that was moving while it was measured: the spike lands in one
  // suite's numbers and then reads as an improvement in every run after it. `--out`
  // still writes, because a result file is a record of what happened.
  const unstable = unstableReference(calibration, budgets.maxRunSpread);
  let refused = false;
  if (process.argv.includes('--update-baseline')) {
    if (unstable === null) {
      await writeResults(baselinePath, baselineFile);
      console.log(`  baseline written to ${baselinePath.slice(REPO.length + 1)}\n`);
    } else {
      refused = true;
      console.error(
        `  baseline NOT written: the ${unstable.kind} reference moved ` +
          `${unstable.spread.toFixed(2)}x between suites, over the ` +
          `${String(budgets.maxRunSpread)}x limit in budgets.json. This run measured a machine ` +
          'that was busy with something else, and a baseline recorded from it would make every ' +
          'later run wrong. Re-run it on a quiet machine.\n',
      );
    }
  }

  const overBudget = failures(comparisons);
  const overtime = mode === 'ci' && elapsedMs / 1000 > budgets.ciMaxSeconds;
  if (overtime) {
    console.error(
      `  the ci profile took ${(elapsedMs / 1000).toFixed(1)} s, over its ` +
        `${String(budgets.ciMaxSeconds)} s ceiling. Reduce sample counts or move a workload to ` +
        '--local, but do not raise the ceiling to make this pass.\n',
    );
  }

  return failed.length > 0 || overBudget.length > 0 || overtime || refused ? 1 : 0;
}

/**
 * Read the already-built artifact as one benchmark-origin adapter. The benchmark never
 * rebuilds or repairs it: bytes under measurement must already have crossed the artifact
 * verification interface.
 *
 * @param {{ name: string, dir: string }} app
 */
async function readArtifactOrigin(app) {
  const root = join(REPO, 'dist', app.name);
  let read;
  try {
    read = await readReport(root);
  } catch (cause) {
    if (cause instanceof Error && /** @type {{ code?: unknown }} */ (cause).code !== 'ENOENT') {
      throw cause;
    }
    throw new Error(
      `No built artifact for ${app.name}; run \`npm run build -- --app ${app.name}\` first.`,
      { cause },
    );
  }
  const report = read.report;
  if (isRemoteReport(report) || report.app !== app.name) {
    throw new Error(`dist/${app.name}/${REPORT} does not describe a benchmarkable artifact.`);
  }
  return {
    report,
    publicDir: join(root, report.public),
    csp: report.security.csp,
    assets: report.files
      .filter((file) => file.cache === 'immutable' && file.path.startsWith(`${report.public}/`))
      .map((file) => `/${file.path.slice(report.public.length + 1)}`),
    cache: {
      immutable: report.cache.immutable,
      revalidate: report.cache.revalidate,
    },
  };
}

/**
 * Take reference readings, discarding them, until two in a row agree.
 *
 * The tolerance is on both references at once: a machine still starting processes moves
 * one of them, and either one moving means the next reading is not yet describing the
 * machine the workloads will get. Bounded attempts, because a machine that never
 * settles is a fact about the environment and the run should proceed and report it
 * rather than spin — the spread check will refuse to gate it anyway.
 *
 * @param {import('./types.js').BenchmarkBrowser} browser
 * @param {{ attempts: number, tolerance: number }} options
 * @returns {Promise<{ settled: boolean, attempts: number }>}
 */
async function settle(browser, options) {
  /** @type {ReferenceReading | null} */
  let previous = null;

  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    const reading = await measureCalibration(browser);
    if (previous !== null && agrees(previous, reading, options.tolerance)) {
      return { settled: true, attempts: attempt };
    }
    previous = reading;
  }

  return { settled: false, attempts: options.attempts };
}

/**
 * @param {ReferenceReading} first
 * @param {ReferenceReading} second
 * @param {number} tolerance
 * @returns {boolean}
 */
function agrees(first, second, tolerance) {
  /** @type {(keyof ReferenceReading)[]} */
  const kinds = ['arithmetic', 'layout'];
  return kinds.every((kind) => {
    if (first[kind] <= 0 || second[kind] <= 0) return false;
    const ratio = second[kind] / first[kind];
    return ratio <= 1 + tolerance && ratio >= 1 / (1 + tolerance);
  });
}

/**
 * Both reference workloads' medians, in milliseconds.
 *
 * Measured through the same page and the same sample loop as everything else, so their
 * own overhead is the overhead the workloads pay too. Sample counts are fixed here
 * rather than in the registry because these are not workloads anybody may filter out:
 * without them there is no scale factor, and without a scale factor the gate is a coin
 * toss on a laptop.
 *
 * One page for both, and a fresh one per reading: the layout reference leaves 4,000
 * elements behind per sample for the scope to release, and a page that has done that
 * seven times is not the page the first reading measured.
 *
 * @param {import('./types.js').BenchmarkBrowser} browser
 * @returns {Promise<ReferenceReading>}
 */
async function measureCalibration(browser) {
  const page = await browser.harnessPage();
  try {
    return {
      arithmetic: await referenceMedian(page, 'reference'),
      layout: await referenceMedian(page, 'layoutReference'),
    };
  } finally {
    await page.close();
  }
}

/**
 * @param {BenchmarkPage} page
 * @param {string} exportName
 * @returns {Promise<number>}
 */
async function referenceMedian(page, exportName) {
  const samples = await runInPage(page, '/__benchmark/calibration.js', exportName, {}, {
    samples: 9,
    warmup: 3,
    once: false,
  });
  /** @type {WorkloadSpec} */
  const spec = {
    id: `harness/calibration-${exportName}`,
    suite: 'tooling',
    title: 'Fixed reference workload',
    driver: 'browser',
    samples: { local: 9, ci: 9 },
    warmup: { local: 3, ci: 3 },
  };
  const record = aggregate(spec, samples, { warmup: 3 });
  return record.metrics[DURATION]?.median ?? 0;
}

/**
 * Read the baseline every comparison is made against, or nothing when there is none.
 *
 * Absent is a legitimate state — the first run of a new baseline file has to produce one
 * — and it is reported as such by `gateReason` rather than passed over. Present and
 * unreadable is not: a corrupt or half-written baseline that read as `null` would make a
 * run silently gate on nothing, which is the failure mode this whole harness exists to
 * avoid. So only ENOENT becomes null and everything else is thrown, naming the file.
 *
 * @param {string} path
 * @returns {Promise<BaselineFile | null>}
 */
async function readBaseline(path) {
  /** @type {string} */
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    if (cause instanceof Error && /** @type {{ code?: unknown }} */ (cause).code === 'ENOENT') {
      return null;
    }
    throw cause;
  }
  try {
    const parsed = /** @type {unknown} */ (JSON.parse(text));
    return /** @type {BaselineFile} */ (parsed);
  } catch (cause) {
    throw new Error(`${path.slice(REPO.length + 1)} is not readable JSON, so nothing can be gated on it.`, {
      cause,
    });
  }
}

/**
 * Why this run gates nothing, when it does not.
 *
 * `comparability` answers this for a baseline that exists and does not match. It cannot
 * answer it for a baseline that is not there, because it is not told which file was
 * looked for — and that case was the quietest of the lot: `--origin dist` has never had
 * an artifact baseline in this repository, so it ran fully ungated and said nothing at
 * all. A run that gates nothing has to say so.
 *
 * @param {BaselineFile | null} baseline
 * @param {string} path
 * @param {'source' | 'dist'} originAdapter
 * @param {string | null} reason
 * @returns {string | null}
 */
function gateReason(baseline, path, originAdapter, reason) {
  if (baseline !== null) return reason;
  return (
    `there is no baseline at ${path.slice(REPO.length + 1)}: every metric reports as new and ` +
    'nothing is gated. Record one on a quiet machine with `node tools/benchmark/run.mjs' +
    `${originAdapter === 'dist' ? ' --origin dist' : ''} --update-baseline\`.`
  );
}

/**
 * Collect one workload's samples, whichever way it is driven.
 *
 * @param {WorkloadSpec} workload
 * @param {import('./types.js').NodeWorkloadContext} context
 * @returns {Promise<BenchmarkSample[]>}
 */
async function collect(workload, context) {
  if (workload.driver === 'node') {
    if (workload.run === undefined) {
      throw new Error(`Workload ${workload.id} is node-driven but declares no run().`);
    }
    return workload.run(context);
  }

  const browser = workload.browser;
  if (browser === undefined) {
    throw new Error(`Workload ${workload.id} is browser-driven but names no module.`);
  }

  const args = { ...browser.args };

  if (workload.driver === 'page') {
    /** @type {BenchmarkSample[]} */
    const samples = [];
    for (let index = 0; index < context.warmup + context.samples; index += 1) {
      const page = await context.browser.harnessPage();
      try {
        const sample = await runInPage(page, browser.module, browser.export, args, {
          samples: 1,
          warmup: 0,
          once: true,
        });
        const first = /** @type {BenchmarkSample} */ (sample[0]);
        if (index >= context.warmup || !first.ok) samples.push(first);
        if (!first.ok) break;
      } finally {
        await page.close();
      }
    }
    return samples;
  }

  const page = await context.browser.harnessPage();
  try {
    return await runInPage(page, browser.module, browser.export, args, {
      samples: context.samples,
      warmup: context.warmup,
      once: false,
    });
  } finally {
    await page.close();
  }
}

/**
 * Hand the sample loop to the page, then check what came back for the two things a
 * workload is never allowed to have done: reach off origin, or leave an uncaught
 * error behind.
 *
 * @param {BenchmarkPage} page
 * @param {string} module
 * @param {string} exportName
 * @param {Record<string, unknown>} args
 * @param {{ samples: number, warmup: number, once: boolean }} options
 * @returns {Promise<BenchmarkSample[]>}
 */
async function runInPage(page, module, exportName, args, options) {
  const body = `async (input) => {
    const support = await import('/__benchmark/support.js');
    const module = await import(input.module);
    const workload = module[input.export];
    if (workload === undefined) {
      throw new Error('No export ' + input.export + ' in ' + input.module);
    }
    return input.once
      ? [await support.runOnce(workload, { args: input.args })]
      : support.runWorkload(workload, { samples: input.samples, warmup: input.warmup, args: input.args });
  }`;

  const samples = await page.evaluate(body, { module, export: exportName, args, ...options });
  const collected = /** @type {BenchmarkSample[]} */ (samples);

  const offOrigin = page.offOrigin();
  if (offOrigin.length > 0) {
    throw new WorkloadFailure(module, `it requested off-origin URLs: ${offOrigin.join(', ')}`);
  }
  const errors = page.errors();
  if (errors.length > 0) {
    throw new WorkloadFailure(module, `the page reported errors: ${errors.join(' | ')}`);
  }

  return collected;
}

process.exitCode = await main();
