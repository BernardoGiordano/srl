/**
 * What a measurement means, with no browser and no filesystem in sight.
 *
 * The harness has two halves and this is the one that can be tested in a
 * millisecond: samples in, one comparable record out. Everything that can go
 * wrong about a number — too few samples, a workload that was fast because it
 * rendered the wrong thing, a comparison against a baseline recorded on another
 * machine — is decided here rather than inside the code that drives Chrome.
 *
 * THREE RULES THIS MODULE ENFORCES
 *
 *  1. Correctness before timing. A sample carries the answer its workload
 *     produced, and `aggregate` refuses the whole workload when any sample's
 *     check failed. A fast wrong render must never be reportable as a fast
 *     render, which is the failure mode that makes homegrown benchmarks worse
 *     than no benchmark at all.
 *  2. A single sample is not a measurement. Every reported figure is a median
 *     and a p95 over a stated sample count, and the count and the warmup count
 *     travel with the figure so a reader can tell a 30-sample median from a
 *     lucky one.
 *  3. A comparison needs the same environment. Regression budgets are relative
 *     to a checked-in baseline, so a baseline from a different machine is
 *     reported as incomparable instead of quietly failing the build for having
 *     a slower CPU.
 */

/**
 * @import { BenchmarkSample, MetricStats, WorkloadRecord, WorkloadSpec,
 *   BaselineFile, CalibrationRecord, Comparison, ComparisonStatus, ReferenceKind,
 *   ReferenceReading, Suite } from './types.js'
 */

/** The metric key used for a timed workload's duration. */
export const DURATION = 'duration';

/**
 * Result-file shape this harness reads and writes. A baseline recorded by an older
 * one is reported as incomparable rather than being interpreted with today's rules:
 * version 1 carried a single calibration number, and dividing by it would scale a
 * render workload by a figure measured with arithmetic.
 */
export const BASELINE_VERSION = 2;

/**
 * Which reference workload normalises which suite.
 *
 * Not a taste question — measured. Under a memory-bandwidth load, three real render
 * workloads slowed by 31%, 34% and 36% while the arithmetic reference reported 12% and
 * the layout reference reported 30%. Scaling by arithmetic would have left ~20% of
 * environmental slowdown looking like a repository regression; scaling by layout left
 * 1–6%, inside the threshold. Everything that runs in a page is therefore scaled by
 * the layout reference.
 *
 * The tooling suite is scaled by arithmetic because neither reference describes a
 * fresh `tsc` process reading a few hundred files, and arithmetic at least tracks the
 * clock. What actually carries that suite is its much wider threshold in budgets.json.
 *
 * @type {Record<Suite, ReferenceKind>}
 */
export const REFERENCE_FOR_SUITE = {
  startup: 'layout',
  template: 'layout',
  router: 'layout',
  collection: 'layout',
  memory: 'layout',
  delivery: 'layout',
  tooling: 'arithmetic',
};

/**
 * Summarise one metric's samples.
 *
 * p95 is nearest-rank over the sorted samples rather than an interpolation: with
 * ten samples an interpolated p95 invents a number that no run produced, and the
 * point of reporting a tail at all is to name a run that actually happened.
 *
 * @param {readonly number[]} values
 * @returns {MetricStats}
 */
export function summarise(values) {
  if (values.length === 0) throw new Error('summarise() needs at least one value.');
  const sorted = [...values].sort((a, b) => a - b);
  return {
    median: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    mean: sorted.reduce((total, value) => total + value, 0) / sorted.length,
    min: /** @type {number} */ (sorted[0]),
    max: /** @type {number} */ (sorted[sorted.length - 1]),
  };
}

/**
 * @param {readonly number[]} sorted
 * @param {number} fraction
 * @returns {number}
 */
function quantile(sorted, fraction) {
  if (fraction <= 0) return /** @type {number} */ (sorted[0]);
  const rank = Math.ceil(fraction * sorted.length) - 1;
  const index = Math.min(sorted.length - 1, Math.max(0, rank));
  return /** @type {number} */ (sorted[index]);
}

/**
 * Thrown when a workload's samples cannot be turned into a measurement: a failed
 * correctness check, or no samples at all. Named so the runner can report it as a
 * workload failure rather than a harness crash.
 */
export class WorkloadFailure extends Error {
  /**
   * @param {string} id
   * @param {string} reason
   */
  constructor(id, reason) {
    super(`Workload "${id}" failed: ${reason}`);
    this.name = 'WorkloadFailure';
    this.id = id;
  }
}

/**
 * Turn a workload's samples into the record that gets printed, written to JSON
 * and compared against a baseline.
 *
 * A timed workload reports `duration` in milliseconds. A measured workload
 * reports whatever numeric metrics it collected — bytes, requests, retained
 * nodes — and each is summarised separately, because a memory workload's heap
 * figure and its node count regress for different reasons.
 *
 * @param {WorkloadSpec} spec
 * @param {readonly BenchmarkSample[]} samples
 * @param {{ warmup: number }} run
 * @returns {WorkloadRecord}
 */
export function aggregate(spec, samples, run) {
  if (samples.length === 0) throw new WorkloadFailure(spec.id, 'it produced no samples.');

  const wrong = samples.find((sample) => !sample.ok);
  if (wrong !== undefined) {
    throw new WorkloadFailure(
      spec.id,
      `a sample produced the wrong result, so its timing is meaningless: ${
        wrong.detail ?? 'no detail reported'
      }`,
    );
  }

  /** @type {Record<string, number[]>} */
  const collected = {};
  for (const sample of samples) {
    if (sample.duration !== undefined) push(collected, DURATION, sample.duration);
    for (const [name, value] of Object.entries(sample.metrics ?? {})) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new WorkloadFailure(spec.id, `metric "${name}" reported ${String(value)}.`);
      }
      push(collected, name, value);
    }
  }

  const names = Object.keys(collected);
  if (names.length === 0) throw new WorkloadFailure(spec.id, 'it reported no metric.');

  /** @type {Record<string, MetricStats>} */
  const metrics = {};
  for (const name of names) {
    metrics[name] = summarise(/** @type {number[]} */ (collected[name]));
  }

  return {
    id: spec.id,
    suite: spec.suite,
    title: spec.title,
    units: spec.units ?? { [DURATION]: 'ms' },
    samples: samples.length,
    warmup: run.warmup,
    metrics,
  };
}

/**
 * @param {Record<string, number[]>} into
 * @param {string} name
 * @param {number} value
 */
function push(into, name, value) {
  (into[name] ??= []).push(value);
}

/**
 * Turn the reference readings taken during a run into the record that travels with
 * its results.
 *
 * One reading is taken before each suite rather than one per run, because the noise
 * this corrects for is local in time: a laptop warms up over ninety seconds, a video
 * plays for thirty, an indexer wakes up once. A single reading at the start describes
 * the machine the first suite got and no other. `spread` is the largest ratio between
 * any two readings of the same reference in one run, and it is how a run reports that
 * the machine did not hold still while it was being measured.
 *
 * A repeated suite keeps its first reading. The runner takes one reading per suite, so
 * this only guards the shape of the record.
 *
 * @param {ReadonlyArray<{ suite: string } & ReferenceReading>} readings
 * @returns {CalibrationRecord}
 */
export function summariseCalibration(readings) {
  if (readings.length === 0) throw new Error('summariseCalibration() needs at least one reading.');

  /** @type {ReferenceKind[]} */
  const kinds = ['arithmetic', 'layout'];
  /** @type {Record<string, ReferenceReading>} */
  const bySuite = {};
  for (const reading of readings) {
    // First reading wins: a suite that reappears later in the registry was measured
    // by the reading taken when it started.
    bySuite[reading.suite] ??= { arithmetic: reading.arithmetic, layout: reading.layout };
  }

  const overall = /** @type {ReferenceReading} */ ({});
  const spread = /** @type {ReferenceReading} */ ({});
  for (const kind of kinds) {
    const values = readings.map((reading) => reading[kind]).filter((value) => value > 0);
    const stats = values.length === 0 ? null : summarise(values);
    overall[kind] = stats === null ? 0 : stats.median;
    spread[kind] = stats === null || stats.min === 0 ? 1 : stats.max / stats.min;
  }

  return { readings: readings.length, overall, bySuite, spread };
}

/**
 * The reference that moved too far during this run, if one did.
 *
 * Two callers, one rule: a run that measured a machine which did not hold still may
 * not fail a build, and may not become the baseline every later run is compared
 * against either.
 *
 * @param {CalibrationRecord} calibration
 * @param {number} maxRunSpread
 * @returns {{ kind: ReferenceKind, spread: number } | null}
 */
export function unstableReference(calibration, maxRunSpread) {
  /** @type {ReferenceKind[]} */
  const kinds = ['arithmetic', 'layout'];
  for (const kind of kinds) {
    const spread = calibration.spread[kind];
    if (spread > maxRunSpread) return { kind, spread };
  }
  return null;
}

/**
 * Decide whether this run may fail a build, and by how much each suite's baseline
 * should be scaled.
 *
 * Four reasons to report instead of gate, and each of them was a false red build
 * before it was a rule:
 *
 *   1. No baseline. Nothing to compare against.
 *   2. A baseline from an older harness. Its calibration means something different.
 *   3. A different machine, by environment profile.
 *   4. A machine that changed too much — either against the baseline's (`maxSpeedDrift`)
 *      or during the run itself (`maxRunSpread`). Scaling by a factor of three is
 *      arithmetic, not measurement, and a machine whose layout reference moved 40%
 *      mid-run cannot tell a regression from the load that caused the move.
 *
 * @param {{
 *   baseline: BaselineFile | null,
 *   profile: string,
 *   calibration: CalibrationRecord,
 *   maxSpeedDrift: number,
 *   maxRunSpread: number,
 * }} input
 * @returns {{ comparable: boolean, reason: string | null, speedBySuite: Record<string, number> }}
 */
export function comparability(input) {
  const { baseline, calibration } = input;
  /** @type {Record<string, number>} */
  const speedBySuite = {};

  if (baseline === null) return { comparable: false, reason: null, speedBySuite };

  const recorded = baseline.calibration;
  if (baseline.version !== BASELINE_VERSION || recorded?.bySuite === undefined) {
    return {
      comparable: false,
      reason:
        `the baseline is a version ${String(baseline.version)} file and this harness writes ` +
        `version ${String(BASELINE_VERSION)}: re-record it with --update-baseline before ` +
        'trusting a comparison.',
      speedBySuite,
    };
  }

  for (const [suite, kind] of Object.entries(REFERENCE_FOR_SUITE)) {
    const now = calibration.bySuite[suite]?.[kind] ?? calibration.overall[kind];
    const then = recorded.bySuite[suite]?.[kind] ?? recorded.overall[kind];
    speedBySuite[suite] = then > 0 && now > 0 ? now / then : 1;
  }

  if (baseline.environment.profile !== input.profile) {
    return {
      comparable: false,
      reason:
        `the baseline was recorded on profile ${baseline.environment.profile}, which is not this ` +
        'one: differences are reported and nothing is failed on them.',
      speedBySuite,
    };
  }

  const unstable = unstableReference(calibration, input.maxRunSpread);
  if (unstable !== null) {
    return {
      comparable: false,
      reason:
        `the ${unstable.kind} reference moved ${unstable.spread.toFixed(2)}x between suites of ` +
        'this run, so the machine changed while it was being measured: differences are reported ' +
        'and nothing is failed on them.',
      speedBySuite,
    };
  }

  /** @type {ReferenceKind[]} */
  const kinds = ['arithmetic', 'layout'];
  for (const kind of kinds) {
    const then = recorded.overall[kind];
    const drift = then > 0 ? calibration.overall[kind] / then : 1;
    if (drift > input.maxSpeedDrift || drift < 1 / input.maxSpeedDrift) {
      return {
        comparable: false,
        reason:
          `the ${kind} reference is ${drift.toFixed(2)}x the baseline's, past the ${String(
            input.maxSpeedDrift,
          )}x limit: this is a different machine or a differently loaded one, so differences are ` +
          'reported and nothing is failed on them.',
        speedBySuite,
      };
    }
  }

  return { comparable: true, reason: null, speedBySuite };
}

/**
 * Compare a run against a checked-in baseline.
 *
 * Two kinds of budget. A *regression* budget is relative: median and p95 may not
 * exceed the baseline by more than `threshold`. A *product* budget is absolute,
 * comes from the target application rather than from a previous run, and is only
 * applied to the metrics that declare one.
 *
 * A regression has to be over the threshold *and* over a minimum meaningful delta
 * for its unit, thresholds are per suite, and the gate reads the median rather than
 * the p95. ADR-0044. Everything is still reported — those rules only decide what can
 * fail a build.
 *
 * The baseline is additionally scaled by how much faster or slower the machine is
 * *now*, from the fixed reference workloads in
 * tools/benchmark/browser/calibration.js. ADR-0043. The factor is per suite
 * (`speedBySuite`), from the reference reading taken when that suite started and the
 * reference kind that suite's work resembles — see `REFERENCE_FOR_SUITE`. A single
 * scalar for the whole run is the fallback, and it is only right when the machine
 * held still from the first workload to the last.
 *
 * Nothing here fails on a missing baseline entry: a new workload has no history,
 * and reporting it as new is more useful than either passing it silently or
 * failing a build for having added a measurement.
 *
 * @param {readonly WorkloadRecord[]} current
 * @param {BaselineFile | null} baseline
 * @param {{
 *   threshold: number,
 *   suiteThresholds?: Record<string, number>,
 *   minDelta?: Record<string, number>,
 *   speed?: number,
 *   speedBySuite?: Record<string, number>,
 *   product?: Record<string, Record<string, number>>,
 *   comparable?: boolean,
 *   environmentIndependent?: readonly string[],
 * }} policy
 * @returns {Comparison[]}
 */
export function compare(current, baseline, policy) {
  const comparable = policy.comparable ?? true;
  const environmentIndependent = new Set(policy.environmentIndependent ?? []);
  /** @type {Map<string, WorkloadRecord>} */
  const before = new Map((baseline?.results ?? []).map((record) => [record.id, record]));

  /** @type {Comparison[]} */
  const comparisons = [];

  for (const record of current) {
    const previous = before.get(record.id);
    for (const [metric, stats] of Object.entries(record.metrics)) {
      const limit = policy.product?.[record.id]?.[metric];
      const overProduct = limit !== undefined && stats.median > limit;
      const baselineStats = previous?.metrics[metric];

      const unit = record.units[metric] ?? '';
      const slack = policy.minDelta?.[unit] ?? 0;
      const threshold = policy.suiteThresholds?.[record.suite] ?? policy.threshold;

      /** @type {ComparisonStatus} */
      let status;
      let change = null;
      if (baselineStats === undefined) {
        status = previous === undefined ? 'new' : 'new-metric';
      } else if (!comparable && !environmentIndependent.has(record.id)) {
        status = 'incomparable';
        change = ratio(baselineStats.median, stats.median);
      } else {
        // How much slower the machine was when this suite ran than when the baseline
        // recorded it: 1.4 means everything here is expected to take 40% longer for
        // reasons that are not code. Only time scales with it — a request count and a
        // byte count do not, so they are compared as recorded.
        const speed = policy.speedBySuite?.[record.suite] ?? policy.speed ?? 1;
        const expected =
          unit === 'ms' ? baselineStats.median * speed : baselineStats.median;
        change = ratio(expected, stats.median);
        const moved = Math.abs(stats.median - expected) >= slack;
        const worse = (change ?? 0) > threshold;
        const better = (change ?? 0) < -threshold;
        if (worse && moved) status = 'regressed';
        else if (better && moved) status = 'improved';
        else if (worse || better) status = 'within-slack';
        else status = 'ok';
      }

      comparisons.push({
        id: record.id,
        metric,
        unit,
        current: stats,
        baseline: baselineStats ?? null,
        change,
        status: overProduct ? 'over-budget' : status,
        productBudget: limit ?? null,
      });
    }
  }

  return comparisons;
}

/**
 * Fractional change, where 0.2 means "20% slower than the baseline". Returns null
 * when the baseline is zero, because a percentage against zero is not a fact
 * about performance.
 *
 * @param {number} from
 * @param {number} to
 * @returns {number | null}
 */
function ratio(from, to) {
  if (from === 0) return null;
  return (to - from) / from;
}

/**
 * The comparisons that must fail a gated run: a regression past the threshold, or
 * an absolute product budget exceeded.
 *
 * @param {readonly Comparison[]} comparisons
 * @returns {Comparison[]}
 */
export function failures(comparisons) {
  return comparisons.filter(
    (entry) => entry.status === 'regressed' || entry.status === 'over-budget',
  );
}
