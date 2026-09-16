/**
 * One run, two outputs. Something a person reads and something a machine compares.
 *
 * Both from the same numbers, in the same call, because a report that is regenerated
 * separately from the JSON eventually disagrees with it. The human half is grouped by
 * suite with medians and p95s side by side, and the machine half is the file the next
 * run compares against and the one that gets checked in as a baseline.
 *
 * Units and coverage both come from `evidence.mjs`, so the report a person reads and the
 * guide a reader is pointed at cannot describe the same run differently.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { coverageLines, formatValue, standingLine } from './evidence.mjs';

/** @import { BaselineFile, CalibrationRecord, Comparison, Environment, EvidenceDocument, Mode, WorkloadRecord } from './types.js' */

/**
 * @param {number | null} change
 * @returns {string}
 */
function formatChange(change) {
  if (change === null) return '';
  const percent = change * 100;
  const sign = percent > 0 ? '+' : '';
  return `${sign}${percent.toFixed(1)}%`;
}

/**
 * `1.24x`, or `unmeasured` when there is nothing to divide by. A factor against zero
 * is not a fact about a machine.
 *
 * @param {number} now
 * @param {number} then
 * @returns {string}
 */
function ratioOf(now, then) {
  return then > 0 && now > 0 ? `${(now / then).toFixed(2)}x` : 'unmeasured';
}

/**
 * The run, as text.
 *
 * @param {{
 *   results: readonly WorkloadRecord[],
 *   comparisons: readonly Comparison[],
 *   environment: Environment,
 *   mode: Mode,
 *   app: string,
 *   elapsedMs: number,
 *   failures: readonly { id: string, reason: string }[],
 *   evidence: EvidenceDocument,
 *   baseline: BaselineFile | null,
 *   comparable: boolean,
 *   reason: string | null,
 *   calibration: CalibrationRecord,
 *   speedBySuite: Record<string, number>,
 * }} run
 * @returns {string}
 */
export function renderReport(run) {
  const lines = [];
  const { environment: env, calibration } = run;

  lines.push('');
  lines.push(`  benchmark  ${run.mode}  app=${run.app}`);
  lines.push(
    `  ${env.platform} ${env.release} ${env.arch}  ${env.cpu}  ${String(env.cores)} cores  ` +
      `${String(env.memoryGiB)} GiB`,
  );
  lines.push(`  node ${env.node}  chrome ${env.chrome}  profile ${env.profile}`);
  lines.push(
    `  reference workloads, median of ${String(calibration.readings)} readings: ` +
      `arithmetic ${calibration.overall.arithmetic.toFixed(1)} ms, ` +
      `layout ${calibration.overall.layout.toFixed(1)} ms; moved ` +
      `${calibration.spread.arithmetic.toFixed(2)}x / ${calibration.spread.layout.toFixed(2)}x ` +
      'during the run',
  );
  // Both factors, because they answer different questions. A machine that is uniformly
  // slower moves both, and a machine that is only busy in the renderer moves one.
  const recorded = run.baseline?.calibration;
  if (recorded?.overall !== undefined) {
    lines.push(
      `  against the baseline's ${recorded.overall.arithmetic.toFixed(1)} ms / ` +
        `${recorded.overall.layout.toFixed(1)} ms: ` +
        `${ratioOf(calibration.overall.arithmetic, recorded.overall.arithmetic)} arithmetic, ` +
        `${ratioOf(calibration.overall.layout, recorded.overall.layout)} layout` +
        (run.comparable ? ', and each suite is scaled by its own reading' : ''),
    );
  }
  lines.push(
    `  runtime dependencies: ${Object.entries(env.dependencies)
      .map(([name, version]) => `${name}@${version}`)
      .join('  ')}`,
  );
  // A missing baseline reads as "not gated" like every other reason a run does not
  // gate, rather than as a milder sentence of its own. An origin that has never had a
  // baseline file is the most ungated a run can be.
  if (run.baseline === null || run.reason !== null) {
    lines.push(`  not gated: ${run.reason ?? 'there is no baseline to compare against.'}`);
  }
  lines.push('');

  /** @type {Map<string, Comparison[]>} */
  const bySuite = new Map();
  for (const comparison of run.comparisons) {
    const record = run.results.find((entry) => entry.id === comparison.id);
    const suite = record?.suite ?? 'other';
    const list = bySuite.get(suite) ?? [];
    list.push(comparison);
    bySuite.set(suite, list);
  }

  for (const [suite, comparisons] of bySuite) {
    lines.push(`  ${suite}`);
    for (const comparison of comparisons) {
      const record = run.results.find((entry) => entry.id === comparison.id);
      const label =
        comparison.metric === 'duration'
          ? comparison.id
          : `${comparison.id} · ${comparison.metric}`;
      const median = formatValue(comparison.current.median, comparison.unit);
      const p95 = formatValue(comparison.current.p95, comparison.unit);
      const samples = record === undefined ? '' : `n=${String(record.samples)}`;
      const against =
        comparison.baseline === null
          ? 'new'
          : `${formatValue(comparison.baseline.median, comparison.unit)} ${formatChange(comparison.change)}`;
      const flag =
        comparison.status === 'regressed'
          ? 'REGRESSED'
          : comparison.status === 'over-budget'
            ? 'OVER BUDGET'
            : comparison.status === 'improved'
              ? 'improved'
              : comparison.status === 'within-slack'
                ? 'within noise slack'
                : '';
      lines.push(
        `    ${label.padEnd(42)} ${median.padStart(10)}  p95 ${p95.padStart(10)}  ${samples.padEnd(6)} ${against.padEnd(20)} ${flag}`,
      );
    }
    lines.push('');
  }

  if (run.failures.length > 0) {
    lines.push('  failed workloads');
    for (const failure of run.failures) lines.push(`    ${failure.id}: ${failure.reason}`);
    lines.push('');
  }

  lines.push(...coverageLines(run.evidence));

  const regressions = run.comparisons.filter(
    (comparison) => comparison.status === 'regressed' || comparison.status === 'over-budget',
  );
  lines.push(
    `  ${String(run.results.length)} workloads, ${String(run.comparisons.length)} metrics, ` +
      `${String(regressions.length)} over budget, ${String(run.failures.length)} failed, ` +
      `${(run.elapsedMs / 1000).toFixed(1)} s`,
  );
  // What the run proved, which is a different count from what it measured, because an
  // incomparable machine still produces every median and gates none of them.
  lines.push(standingLine(run.evidence));
  lines.push('');

  return lines.join('\n');
}

/**
 * The run, as the file the next one compares against.
 *
 * The directory is created rather than required. An application-owned baseline lives
 * beside the application repository's own `benchmark/`, and the first run that records
 * one is by definition the run where that directory does not exist yet. Requiring it
 * ends in an ENOENT stack trace, which reads as a broken harness rather than as the one
 * step that opens a gate.
 *
 * @param {string} path
 * @param {BaselineFile} file
 * @returns {Promise<void>}
 */
export async function writeResults(path, file) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
}
