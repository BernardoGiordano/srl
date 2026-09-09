/**
 * One interface between a measurement and a performance claim.
 *
 * A number becomes a claim the moment somebody quotes it, and until this module existed
 * the quoting happened three times over: the runner printed a report, the guide restated
 * a table by hand, and a reader reconstructed what was actually proved from a baseline
 * file, a budgets file and a prose paragraph. Three assemblies of the same facts drift,
 * and they drifted in the direction that flatters: the guide claimed 88 ms and Chrome 150
 * while the checked-in baseline said otherwise, and the workloads nobody had run were a
 * sentence somewhere else again.
 *
 * WHAT A CLAIM CARRIES
 *
 * A median, and the three things that decide what it is worth. Its provenance — which
 * machine, which browser, which dependency versions, how far the reference readings moved
 * while it was taken. Its standing — `limited` when an absolute budget holds it on any
 * machine, `gated` when a later run is compared against it, `reported` when nothing fails
 * if it moves. And the coverage around it, because a green run of half the workloads is
 * not evidence about the other half.
 *
 * WHY STANDING IS COMPUTED HERE AND NOT READ FROM THE RUN
 *
 * `measure.mjs` decides whether a comparison failed. That is a different question from
 * what a number proves, and only the second one reaches a reader. An incomparable run
 * still produces medians, and those medians are exactly the numbers somebody copies into
 * a slide. So an incomparable run demotes every claim it did not hold absolutely, and the
 * demotion is a field rather than a footnote: a caller that wants to print "gated" has to
 * read a value that says so. ADR-0044 sets when a difference is real; this sets when a
 * number may be quoted as proved.
 *
 * ORIGINS ARE ADAPTERS
 *
 * Source and dist are two measured sets of the same shape — a `BaselineFile` — read from
 * two files. The runner builds one from the run it just finished; the documentation check
 * reads both from disk. Neither knows anything this module does not.
 *
 * ADR-0099.
 */

import { DURATION } from './measure.mjs';

/**
 * What an artifact baseline records, and why it is not everything the dist origin runs.
 *
 * Dist timings stay evidence rather than gates until their sample policy is settled, so
 * the file carries the one deterministic inventory workload and nothing else. `run.mjs`
 * filters by this list when it writes; the evidence names the consequence, because forty
 * dist workloads reported as "absent from the baseline" would read as an oversight rather
 * than as the decision it is.
 */
export const DIST_BASELINE = {
  ids: /** @type {readonly string[]} */ (['delivery/artifact-size']),
  reason:
    'measured on the artifact origin and deliberately not recorded: dist timings stay ' +
    'evidence rather than gates until their sample policy is settled',
};

/** @import { BaselineFile, Claim, CoverageGap, EvidenceDocument, EvidenceGate, Provenance, Standing, WorkloadRecord, WorkloadSpec } from './types.js' */

/**
 * Format one measured value for a reader.
 *
 * Units are formatted at the edge only, here. Everything upstream is milliseconds, bytes
 * or counts, so nothing has to parse "1.2 MB" back into a number to compare it.
 *
 * @param {number} value
 * @param {string} unit
 * @returns {string}
 */
export function formatValue(value, unit) {
  if (unit.endsWith('bytes')) {
    if (Math.abs(value) >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
    if (Math.abs(value) >= 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${value.toFixed(0)} B`;
  }
  if (unit === 'count') return value.toFixed(0);
  if (unit === 'depth') return `${value.toFixed(0)} deep`;
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(2)} s`;
  if (Math.abs(value) >= 10) return `${value.toFixed(1)} ms`;
  return `${value.toFixed(2)} ms`;
}

/**
 * The metric a workload is quoted by.
 *
 * `duration` when it has one, because that is what a workload is normally asked about,
 * and otherwise the first metric it declared — `delivery/artifact-size` starts a browser
 * for nothing and measures files rather than time.
 *
 * @param {WorkloadRecord} record
 * @returns {string | undefined}
 */
function primaryMetric(record) {
  if (record.metrics[DURATION] !== undefined) return DURATION;
  return Object.keys(record.metrics)[0];
}

/**
 * Assemble every claim one measured set supports.
 *
 * @param {{
 *   origin: 'source' | 'dist',
 *   from: string,
 *   file: BaselineFile | null,
 *   declared: readonly WorkloadSpec[],
 *   inGate: ReadonlySet<string>,
 *   pending: ReadonlyArray<{ id: string, reason: string }>,
 *   product?: Record<string, Record<string, number>>,
 *   environmentIndependent?: readonly string[],
 *   comparable?: boolean,
 *   reason?: string | null,
 *   automated?: boolean | null,
 *   recorded?: { ids: readonly string[], reason: string },
 * }} input
 * @returns {EvidenceDocument}
 */
export function performanceEvidence(input) {
  const file = input.file;
  const records = file?.results ?? [];
  const comparable = input.comparable ?? file !== null;
  const reason = input.reason ?? null;
  const independent = new Set(input.environmentIndependent ?? []);

  /** @type {Claim[]} */
  const claims = [];
  for (const record of records) {
    const primary = primaryMetric(record);
    for (const [metric, stats] of Object.entries(record.metrics)) {
      const unit = record.units[metric] ?? '';
      const limit = input.product?.[record.id]?.[metric];

      /** @type {Standing} */
      let standing;
      let basis;
      if (limit !== undefined) {
        standing = 'limited';
        basis = `absolute limit ${formatValue(limit, unit)}, compared raw on any machine`;
      } else if (!comparable && !independent.has(record.id)) {
        standing = 'reported';
        // The run's own words when it has them: `comparability` says which of the four
        // reasons it was, and repeating a vaguer sentence here would lose that.
        basis =
          reason ??
          'measured on a machine this evidence cannot compare, so nothing fails when it moves';
      } else {
        standing = 'gated';
        basis = 'a later run on this environment profile fails if the median regresses';
      }

      claims.push({
        id: record.id,
        suite: record.suite,
        title: record.title,
        metric,
        unit,
        median: stats.median,
        p95: stats.p95,
        samples: record.samples,
        primary: metric === primary,
        standing,
        basis,
        limit: limit ?? null,
      });
    }
  }

  const measured = new Set(records.map((record) => record.id));
  const declared = new Set(input.declared.map((workload) => workload.id));

  // A workload the file was never meant to carry is not a hole in the evidence, and a
  // workload it was meant to carry and does not have is exactly that. The two read
  // identically from the file alone, so the policy has to be told rather than inferred.
  const carried = input.recorded === undefined ? null : new Set(input.recorded.ids);

  /** @type {CoverageGap[]} */
  const unmeasured = input.declared
    .filter((workload) => !measured.has(workload.id))
    .filter((workload) => carried === null || carried.has(workload.id))
    .map((workload) => ({
      id: workload.id,
      kind: /** @type {const} */ ('unmeasured'),
      reason: `declared and absent from ${input.from}: nothing here proves it`,
    }));

  /** @type {CoverageGap[]} */
  const outsideGate = input.declared
    .filter(
      (workload) =>
        !input.inGate.has(workload.id) || (carried !== null && !carried.has(workload.id)),
    )
    .map((workload) => ({
      id: workload.id,
      kind: input.inGate.has(workload.id)
        ? /** @type {const} */ ('unrecorded')
        : /** @type {const} */ ('local only'),
      reason: input.inGate.has(workload.id)
        ? /** @type {{ reason: string }} */ (input.recorded).reason
        : 'runs in the local profile only, so the bounded gate never sees it',
    }));

  /** @type {CoverageGap[]} */
  const undeclared = records
    .filter((record) => !declared.has(record.id))
    .map((record) => ({
      id: record.id,
      kind: /** @type {const} */ ('undeclared'),
      reason: `recorded in ${input.from} and no longer declared by the registry`,
    }));

  const standings = claims.map((claim) => claim.standing);

  /** @type {EvidenceGate['limits']} */
  const limits = [];
  for (const [id, metrics] of Object.entries(input.product ?? {})) {
    for (const [metric, limit] of Object.entries(metrics)) {
      const claim = claims.find((entry) => entry.id === id && entry.metric === metric);
      limits.push({
        id,
        metric,
        limit,
        unit: claim?.unit ?? null,
        recorded: claim?.median ?? null,
      });
    }
  }

  return {
    origin: input.origin,
    from: input.from,
    provenance: file === null ? null : provenanceOf(file),
    claims,
    coverage: {
      pending: input.pending.map((entry) => ({
        id: entry.id,
        kind: /** @type {const} */ ('pending'),
        reason: entry.reason,
      })),
      unmeasured,
      outsideGate,
      undeclared,
    },
    gate: {
      comparable,
      reason,
      automated: input.automated ?? null,
      limited: standings.filter((standing) => standing === 'limited').length,
      gated: standings.filter((standing) => standing === 'gated').length,
      reported: standings.filter((standing) => standing === 'reported').length,
      limits,
    },
  };
}

/**
 * @param {BaselineFile} file
 * @returns {Provenance}
 */
function provenanceOf(file) {
  const env = file.environment;
  return {
    recorded: file.recorded,
    mode: file.mode,
    app: file.app,
    machine: `${env.cpu}, ${String(env.cores)} cores, ${String(env.memoryGiB)} GiB, ${env.platform} ${env.release} ${env.arch}`,
    runtime: `Node ${env.node}, ${env.chrome}`,
    profile: env.profile,
    dependencies: env.dependencies,
    readings: file.calibration.readings,
    references: file.calibration.overall,
    spread: file.calibration.spread,
  };
}

/**
 * Whether a workflow file runs the benchmark gate.
 *
 * Pure over the text, because the fact matters more than the file: a repository whose
 * documented numbers are gated by nothing that runs on its own is a repository where
 * "the gate is green" means "somebody ran it once, on their laptop". That sentence
 * belongs in the guide, and it may only be written by reading the workflow.
 *
 * @param {string} workflow
 * @returns {boolean}
 */
export function runsTheGate(workflow) {
  return /\bnpm run benchmark(:ci)?\b|\bbenchmark\/run\.mjs\b/u.test(workflow);
}

/**
 * Gaps that share a reason, gathered.
 *
 * One decision can cover fifty workloads — the artifact baseline records one of them on
 * purpose — and repeating its sentence fifty times buries the gaps that are each their
 * own story. Grouping is done here rather than in each reader so the report and the guide
 * summarise the same way.
 *
 * @param {EvidenceDocument} evidence
 * @returns {Array<{ kind: string, reason: string, ids: string[] }>}
 */
export function groupGaps(evidence) {
  const { pending, unmeasured, outsideGate, undeclared } = evidence.coverage;
  /** @type {Map<string, { kind: string, reason: string, ids: string[] }>} */
  const groups = new Map();
  for (const gap of [...pending, ...unmeasured, ...outsideGate, ...undeclared]) {
    const key = `${gap.kind}\u0000${gap.reason}`;
    const group = groups.get(key) ?? { kind: gap.kind, reason: gap.reason, ids: [] };
    group.ids.push(gap.id);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * What a run does not cover, as report lines.
 *
 * The runner prints this so a green exit cannot be read as full coverage, and the guide
 * generates the same lists from the same call. ADR-0037.
 *
 * @param {EvidenceDocument} evidence
 * @returns {string[]}
 */
export function coverageLines(evidence) {
  const groups = groupGaps(evidence);
  if (groups.length === 0) return [];

  const lines = ['  not covered by this evidence'];
  for (const group of groups) {
    const named = group.ids.slice(0, 4).join(', ');
    const rest = group.ids.length - 4;
    const ids = rest > 0 ? `${named} and ${String(rest)} more` : named;
    lines.push(`    ${group.kind}: ${ids}`);
    lines.push(`      ${group.reason}`);
  }
  lines.push('');
  return lines;
}

/**
 * What the run proved, in one line.
 *
 * @param {EvidenceDocument} evidence
 * @returns {string}
 */
export function standingLine(evidence) {
  const { gate } = evidence;
  return (
    `  ${String(gate.gated)} metrics gated, ${String(gate.limited)} absolutely limited, ` +
    `${String(gate.reported)} reported only`
  );
}
