/**
 * The performance guide's claims, generated from the measurements they come from.
 *
 *   node tools/checks/performance-check.mjs            fail if a generated section drifted
 *   node tools/checks/performance-check.mjs --write     rewrite the generated sections
 *   node tools/checks/performance-check.mjs --file X    operate on X instead of the guide
 *
 * A performance number copied into prose once outlives the run that produced it. A
 * typed envelope table can say 88 ms, 51 requests and Chrome 150 while the checked-in
 * baseline says 84.6 ms, 57 requests and Chrome 151, and nothing in the repository
 * notices. Every row here is derived from `tools/benchmark/evidence.mjs` instead, from
 * the same baselines the gate compares against, so a number in the guide cannot
 * disagree with the number the harness holds.
 *
 * It also generates what a table of medians cannot say on its own. Which machine and
 * which browser produced them. Which of them a later run actually fails on, and which are
 * reported only. What is declared and unmeasured. And whether anything automated runs the
 * gate at all, read from the workflows rather than assumed, because "the gate is green"
 * means very little when the gate runs on one laptop by hand.
 *
 * Prose stays hand-written. Only the blocks between the markers are owned here, and the
 * marker grammar is `generated.mjs`'s. Diagnostics are returned rather than printed, so a
 * suite can assert which section drifted. ADR-0072.
 *
 * No browser and no network. It reads two baseline files, the budgets, the workload
 * registry and the workflows. ADR-0099.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { outputFormat, report } from '../../cli/diagnostics/index.mjs';
import { REPO, readText, repoPath } from '../../cli/layout.mjs';
import {
  DIST_BASELINE,
  formatValue,
  groupGaps,
  performanceEvidence,
  runsTheGate,
} from '../benchmark/evidence.mjs';
import { PENDING, selectWorkloads } from '../benchmark/workloads.mjs';
import { rewriteGenerated, table } from './generated.mjs';

/** @import { BaselineFile, BudgetFile, Claim, EvidenceDocument, EvidenceGate } from '../benchmark/types.js' */

/** The page the generated performance blocks live on, unless `--file` says otherwise. */
const DEFAULT_TARGET = 'docs/guide/performance.md';

const SOURCE_BASELINE = join(REPO, 'tools/benchmark/baseline.json');
const ARTIFACT_BASELINE = join(REPO, 'benchmark/artifact-baseline.json');
const BUDGETS = join(REPO, 'tools/benchmark/budgets.json');
const WORKFLOWS = join(REPO, '.github/workflows');

/**
 * Report inventory is deterministic, so it stays gated on a machine that moved. The same
 * list the runner passes to `compare`.
 */
const ENVIRONMENT_INDEPENDENT = ['delivery/artifact-size'];

/**
 * @param {string} path
 * @returns {Promise<BaselineFile | null>}
 */
async function readBaseline(path) {
  try {
    const parsed = /** @type {unknown} */ (JSON.parse(await readFile(path, 'utf8')));
    return /** @type {BaselineFile} */ (parsed);
  } catch (cause) {
    if (cause instanceof Error && /** @type {{ code?: unknown }} */ (cause).code === 'ENOENT') {
      return null;
    }
    throw new Error(`${repoPath(path)} is not readable JSON, so no claim can be made from it.`, {
      cause,
    });
  }
}

/**
 * Whether anything that runs on its own runs the benchmark gate.
 *
 * @returns {Promise<boolean | null>}
 */
async function automated() {
  /** @type {string[]} */
  let files;
  try {
    files = await readdir(WORKFLOWS);
  } catch {
    return null;
  }
  for (const file of files.filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))) {
    if (runsTheGate(await readText(join(WORKFLOWS, file)))) return true;
  }
  return false;
}

/**
 * The application a baseline was recorded for. `example:dist` is the example application
 * measured through the artifact origin, and the registry filters by the name alone.
 *
 * @param {BaselineFile | null} file
 * @returns {string | undefined}
 */
function appOf(file) {
  return file === null ? undefined : file.app.split(':')[0];
}

/**
 * Both origins, as evidence.
 *
 * @returns {Promise<EvidenceDocument[]>}
 */
export async function readEvidence() {
  const budgets = /** @type {BudgetFile} */ (
    /** @type {unknown} */ (JSON.parse(await readFile(BUDGETS, 'utf8')))
  );
  const ci = await automated();

  /** @type {EvidenceDocument[]} */
  const documents = [];
  for (const origin of /** @type {const} */ (['source', 'dist'])) {
    const path = origin === 'source' ? SOURCE_BASELINE : ARTIFACT_BASELINE;
    const file = await readBaseline(path);
    const app = appOf(file);
    const filter = { app, origin };
    documents.push(
      performanceEvidence({
        origin,
        from: repoPath(path),
        file,
        declared: selectWorkloads('local', filter),
        inGate: new Set(selectWorkloads('ci', filter).map((workload) => workload.id)),
        // The dist origin ships no source templates, so the bundle workload is not a gap
        // there. The runner draws the same line.
        pending:
          origin === 'dist'
            ? PENDING.filter((entry) => entry.id !== 'startup/templates-bundle')
            : PENDING,
        product: budgets.product,
        environmentIndependent: ENVIRONMENT_INDEPENDENT,
        automated: ci,
        ...(origin === 'dist' ? { recorded: DIST_BASELINE } : {}),
      }),
    );
  }
  return documents;
}

/** @param {EvidenceDocument} evidence */
function heading(evidence) {
  return evidence.origin === 'source'
    ? 'Source origin — the application served as it is written'
    : 'Artifact origin — the verified production build';
}

/** @param {Claim} claim */
function standingOf(claim) {
  if (claim.standing === 'limited') return `limited to ${formatValue(claim.limit ?? 0, claim.unit)}`;
  return claim.standing;
}

/**
 * Where the numbers came from.
 *
 * @param {readonly EvidenceDocument[]} documents
 * @returns {string}
 */
function provenanceSection(documents) {
  const blocks = documents.map((evidence) => {
    const provenance = evidence.provenance;
    if (provenance === null) {
      return `**${heading(evidence)}.** No measurement is recorded at \`${evidence.from}\`, so this guide claims nothing about it.`;
    }
    const dependencies = Object.entries(provenance.dependencies)
      .map(([name, version]) => `\`${name}@${version}\``)
      .join(', ');
    return [
      `**${heading(evidence)}.** \`${evidence.from}\``,
      '',
      table(
        ['Fact', 'Value'],
        [
          ['Recorded', `${provenance.recorded}, \`--${provenance.mode}\`, app \`${provenance.app}\``],
          ['Machine', provenance.machine],
          ['Runtime', provenance.runtime],
          ['Environment profile', `\`${provenance.profile}\``],
          ['Runtime dependencies', dependencies],
          [
            'Reference readings',
            `${String(provenance.readings)} readings, arithmetic ` +
              `${provenance.references.arithmetic.toFixed(1)} ms and layout ` +
              `${provenance.references.layout.toFixed(1)} ms, moved ` +
              `${provenance.spread.arithmetic.toFixed(2)}x / ` +
              `${provenance.spread.layout.toFixed(2)}x during the run`,
          ],
        ],
      ),
    ].join('\n');
  });
  return blocks.join('\n\n');
}

/**
 * One row per workload, holding the number it is quoted by.
 *
 * @param {readonly EvidenceDocument[]} documents
 * @returns {string}
 */
function envelopeSection(documents) {
  const blocks = documents.map((evidence) => {
    const claims = evidence.claims.filter((claim) => claim.primary);
    if (claims.length === 0) return `**${heading(evidence)}.** Nothing recorded.`;
    return [
      `**${heading(evidence)}.**`,
      '',
      table(
        ['Workload', 'Id', 'Median', 'p95', 'n', 'Standing'],
        claims.map((claim) => [
          claim.title,
          `\`${claim.id}\``,
          formatValue(claim.median, claim.unit),
          formatValue(claim.p95, claim.unit),
          String(claim.samples),
          standingOf(claim),
        ]),
      ),
    ].join('\n');
  });
  return blocks.join('\n\n');
}

/**
 * Everything else a workload measured, such as requests, bytes, chain depth, startup
 * steps and heap.
 *
 * @param {readonly EvidenceDocument[]} documents
 * @returns {string}
 */
function factsSection(documents) {
  const claims = documents.flatMap((evidence) =>
    evidence.claims.filter((claim) => !claim.primary).map((claim) => ({ evidence, claim })),
  );
  if (claims.length === 0) return 'Every recorded workload measures one number.';
  return table(
    ['Id', 'Metric', 'Median', 'Standing'],
    claims.map(({ claim }) => [
      `\`${claim.id}\``,
      `\`${claim.metric}\``,
      formatValue(claim.median, claim.unit),
      standingOf(claim),
    ]),
  );
}

/**
 * Workload ids, or, past the point where a list stops being read, how many and from
 * where. The families are the id prefixes, so a reader can reproduce the list from the
 * registry rather than scroll one cell of a table.
 *
 * @param {readonly string[]} ids
 * @returns {string}
 */
function listOf(ids) {
  if (ids.length <= 8) return ids.map((id) => `\`${id}\``).join(', ');
  const families = [...new Set(ids.map((id) => id.split('/')[0] ?? id))];
  return `${String(ids.length)} workloads across ${families.join(', ')}`;
}

/**
 * What the numbers do not cover.
 *
 * @param {readonly EvidenceDocument[]} documents
 * @returns {string}
 */
function coverageSection(documents) {
  const blocks = documents.map((evidence) => {
    const groups = groupGaps(evidence);
    if (groups.length === 0) {
      return `**${heading(evidence)}.** Every declared workload is measured and gated.`;
    }
    return [
      `**${heading(evidence)}.**`,
      '',
      table(
        ['Gap', 'Workloads', 'Why'],
        groups.map((group) => [group.kind, listOf(group.ids), group.reason]),
      ),
    ].join('\n');
  });
  return blocks.join('\n\n');
}

/**
 * What fails, and what merely reports.
 *
 * @param {readonly EvidenceDocument[]} documents
 * @returns {string}
 */
function gatingSection(documents) {
  const lines = [];
  const ci = documents[0]?.gate.automated ?? null;
  lines.push(
    ci === true
      ? 'A workflow in `.github/workflows` runs the benchmark gate, so these limits fail on their own.'
      : ci === false
        ? 'No workflow in `.github/workflows` runs the benchmark gate: every limit below fails only when somebody runs `npm run benchmark:ci` by hand, on a machine whose profile matches the baseline. A green `npm run check` proves nothing about performance.'
        : 'The workflows could not be read, so whether anything runs the gate automatically is unknown.',
  );
  lines.push('');
  lines.push(
    table(
      ['Origin', 'Gated', 'Absolutely limited', 'Reported only', 'Comparable'],
      documents.map((evidence) => [
        `\`${evidence.origin}\``,
        String(evidence.gate.gated),
        String(evidence.gate.limited),
        String(evidence.gate.reported),
        evidence.gate.comparable ? 'yes' : `no — ${evidence.gate.reason ?? 'no baseline'}`,
      ]),
    ),
  );

  // Every declared limit, including one on a workload nothing has measured, because a
  // limit that holds nothing is the entry a reader most needs to see.
  /** @type {Map<string, EvidenceGate['limits'][number]>} */
  const limits = new Map();
  for (const evidence of documents) {
    for (const limit of evidence.gate.limits) {
      const key = `${limit.id}.${limit.metric}`;
      const known = limits.get(key);
      if (known === undefined || (known.recorded === null && limit.recorded !== null)) {
        limits.set(key, limit);
      }
    }
  }
  if (limits.size > 0) {
    lines.push('');
    lines.push(
      table(
        ['Absolute limit', 'Value', 'Recorded'],
        [...limits.entries()].map(([key, limit]) => [
          `\`${key}\``,
          limit.unit === null ? String(limit.limit) : formatValue(limit.limit, limit.unit),
          limit.recorded === null
            ? 'nothing has measured it'
            : formatValue(limit.recorded, limit.unit ?? ''),
        ]),
      ),
    );
  }
  return lines.join('\n');
}

/**
 * Every generated block, keyed by the name in its marker.
 *
 * @param {readonly EvidenceDocument[]} documents
 * @returns {Map<string, string>}
 */
export function sections(documents) {
  return new Map([
    ['performance-provenance', provenanceSection(documents)],
    ['performance-envelope', envelopeSection(documents)],
    ['performance-facts', factsSection(documents)],
    ['performance-coverage', coverageSection(documents)],
    ['performance-gating', gatingSection(documents)],
  ]);
}

/**
 * @param {{ file?: string, write?: boolean, documents?: readonly EvidenceDocument[] }} [options]
 * @returns {Promise<{ diagnostics: import('../../cli/diagnostics/types.js').Diagnostic[], drifted: string[], text: string | null }>}
 */
export async function checkPerformanceGuide(options = {}) {
  const file = options.file ?? join(REPO, DEFAULT_TARGET);
  const text = await readText(file);
  const write = options.write === true;
  const documents = options.documents ?? (await readEvidence());
  const { out, drifted, diagnostics } = rewriteGenerated(text, sections(documents), {
    file,
    write,
    command: 'npm run docs:performance:write',
  });
  if (write && out !== null && out !== text) await writeFile(file, out, 'utf8');
  return { diagnostics, drifted, text: out };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const write = process.argv.includes('--write');
  const index = process.argv.indexOf('--file');
  const file = index === -1 ? undefined : process.argv[index + 1];

  const { diagnostics } = await checkPerformanceGuide({ file, write });
  process.exitCode = report(diagnostics, {
    format: outputFormat(),
    summary: `The generated sections of ${file ?? DEFAULT_TARGET} come from the recorded baselines.`,
  });
}
