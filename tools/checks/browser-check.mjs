/**
 * The browser support matrix, generated from the run that earned it.
 *
 *   node tools/checks/browser-check.mjs             fail if a generated section drifted
 *   node tools/checks/browser-check.mjs --write      rewrite the generated sections
 *   node tools/checks/browser-check.mjs --file X     operate on X instead of the guide
 *
 * "Supported browsers: Chrome, Firefox, Safari" is a sentence anyone can type, and a
 * reader has no way to tell it from a sentence somebody earned. This page's table is
 * derived instead, from `tools/browser/journeys.json`, which a recorded run of the
 * journey writes, and from the engine registry the suite itself iterates. An engine that
 * stopped running disappears from the matrix on the next recording rather than on the
 * day somebody remembers.
 *
 * It also generates the two things a matrix cannot say on its own. What the journey
 * actually did, step by step, so "passed" has a referent. And what is not covered, which
 * is the engines with no recorded run, the screen readers nobody has driven, and the
 * parts of the application the journey never visits.
 *
 * Prose stays hand-written. The marker grammar is `generated.mjs`'s, and the diagnostics
 * are returned rather than printed. ADR-0072, ADR-0116.
 *
 * No browser and no network. It reads two JSON files and the workflows.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { outputFormat, report } from '../../cli/diagnostics/index.mjs';
import { REPO, readText, repoPath } from '../../cli/layout.mjs';
import { ENGINES } from '../../cli/test/support/journey/engines.mjs';
import { rewriteGenerated, table } from './generated.mjs';

/** @import { AssistiveRecord, EngineRecord, JourneyRecord } from '../browser/types.js' */

/** The page the generated blocks live on, unless `--file` says otherwise. */
const DEFAULT_TARGET = 'docs/guide/browser-support.md';

const RECORD = join(REPO, 'tools/browser/journeys.json');
const ASSISTIVE = join(REPO, 'tools/browser/assistive.json');
const WORKFLOWS = join(REPO, '.github/workflows');

/** The command CI runs. An engine only runs on its own if this is in a workflow. */
const CHECK_COMMAND = 'npm run check';

/**
 * @param {string} path
 * @returns {Promise<unknown>}
 */
async function readJson(path) {
  try {
    const parsed = /** @type {unknown} */ (JSON.parse(await readFile(path, 'utf8')));
    return parsed;
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
 * Whether anything that runs on its own runs the suite the journey is in.
 *
 * Read from the workflows rather than assumed, for the same reason the performance
 * guide reads its own gate. "It runs in CI" is the difference between a claim that
 * decays and one that does not, and it is a fact about a file.
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
    if ((await readText(join(WORKFLOWS, file))).includes(CHECK_COMMAND)) return true;
  }
  return false;
}

/**
 * The engines, each with whatever the last recording found, including the ones it found
 * nothing for.
 *
 * @param {JourneyRecord | null} record
 * @returns {Array<{ declared: (typeof ENGINES)[number], run: EngineRecord | undefined }>}
 */
function matrix(record) {
  return ENGINES.map((declared) => ({
    declared,
    run: record?.engines.find((engine) => engine.id === declared.id),
  }));
}

/**
 * What ran, on what, and whether it passed.
 *
 * @param {JourneyRecord | null} record
 * @returns {string}
 */
function matrixSection(record) {
  if (record === null) {
    return (
      'No run is recorded at `tools/browser/journeys.json`, so this page claims nothing ' +
      'about any browser. Run `npm run journey:record` and commit the result.'
    );
  }
  return [
    table(
      ['Engine', 'Browser', 'Build', 'Journey', 'Next control'],
      matrix(record).map(({ declared, run }) => [
        declared.engine,
        declared.title,
        run === undefined ? '—' : `\`${run.version}\``,
        run === undefined
          ? 'never recorded'
          : run.outcome === 'passed'
            ? 'passed'
            : `failed — ${run.failure ?? 'no reason recorded'}`,
        `\`${declared.nextControl}\``,
      ]),
    ),
    '',
    `Recorded ${record.recordedAt} on ${record.machine.cpu}, ${record.machine.platform} ` +
      `${record.machine.release} (${record.machine.arch}), Node ${record.machine.node}, ` +
      `driven by \`${record.driver.name}@${record.driver.version}\`.`,
    '',
    `The journey drove the built \`${record.app}\` artifact served under the policy the ` +
      'build emitted:',
    '',
    '```',
    record.csp,
    '```',
  ].join('\n');
}

/**
 * The journey itself, step by step, with one engine's readings beside each step.
 *
 * @param {JourneyRecord | null} record
 * @returns {string}
 */
function journeySection(record) {
  const reference = record?.engines.find((engine) => engine.outcome === 'passed');
  if (record === null || reference === undefined) {
    return 'No passing run is recorded, so there are no steps to describe.';
  }
  return [
    `Every engine above ran these steps in this order. The readings are ` +
      `${reference.title} ${reference.version}'s; the other engines observed the same ` +
      'facts, which is what made them pass.',
    '',
    table(
      ['Step', 'What it proves', 'Observed'],
      reference.steps.map((step) => [
        `\`${step.id}\``,
        step.title,
        Object.entries(step.observed)
          .map(([key, value]) => `${key}: ${format(value)}`)
          .join('; '),
      ]),
    ),
  ].join('\n');
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function format(value) {
  if (Array.isArray(value)) return value.length === 0 ? 'none' : value.map(format).join(', ');
  if (typeof value === 'string') return value === '' ? "''" : value;
  return String(value);
}

/**
 * The manual passes, which nothing here can produce.
 *
 * @param {AssistiveRecord | null} assistive
 * @returns {string}
 */
function assistiveSection(assistive) {
  const checks = assistive?.checks ?? [];
  if (checks.length === 0) {
    return (
      'No screen-reader pass is recorded in `tools/browser/assistive.json`. The journey ' +
      'asserts on the accessibility surface — roles, names, `aria-activedescendant`, ' +
      '`aria-rowindex`, `aria-describedby`, where focus is — and a driver reading those ' +
      'attributes is not a screen reader announcing them. **This project therefore makes ' +
      'no assistive-technology claim at all.**'
    );
  }
  return table(
    ['Screen reader', 'Browser', 'Platform', 'Checked', 'Steps', 'Outcome', 'Notes'],
    checks.map((check) => [
      check.reader,
      check.browser,
      check.platform,
      check.checkedAt,
      check.steps.map((step) => `\`${step}\``).join(', '),
      check.outcome,
      check.notes,
    ]),
  );
}

/**
 * What the matrix above does not cover. The half a reader has to be told, because it is
 * the half that cannot be seen by looking at a green table.
 *
 * @param {JourneyRecord | null} record
 * @param {AssistiveRecord | null} assistive
 * @param {boolean | null} ci
 * @returns {string}
 */
function limitsSection(record, assistive, ci) {
  /** @type {Array<[string, string]>} */
  const rows = [];

  const never = matrix(record).filter((entry) => entry.run === undefined);
  if (never.length > 0) {
    rows.push([
      'Engines never recorded',
      `${never.map((entry) => entry.declared.title).join(', ')} — declared and not run.`,
    ]);
  }

  rows.push([
    'Assistive technology',
    (assistive?.checks ?? []).length === 0
      ? 'No screen reader has been driven over this journey. ARIA attributes are asserted; announcements are not.'
      : `${String((assistive?.checks ?? []).length)} manual pass(es) recorded, each covering only the steps it lists.`,
  ]);

  rows.push([
    'Runs on its own',
    ci === true
      ? `A workflow runs \`${CHECK_COMMAND}\`, which includes the journey suite, so a regression fails a pull request.`
      : ci === false
        ? `No workflow runs \`${CHECK_COMMAND}\`, so the journey only runs when somebody runs it.`
        : 'The workflows could not be read, so whether anything runs the journey automatically is unknown.',
  ]);

  rows.push([
    'One journey, not the application',
    'The steps above are the only composed path proved on more than one engine. Every other screen is covered by the Chrome-only suites.',
  ]);

  rows.push([
    'Backwards through a window',
    'A window renders a slice, so keyboard focus can only reach the rows in it. Moving focus backwards stops at the first rendered row instead of pulling earlier rows in, and the journey does not claim otherwise.',
  ]);

  rows.push([
    'One build each',
    record === null
      ? 'Nothing is recorded.'
      : 'A passing engine is the build named in the matrix, not every version of it. Nothing here says anything about an older or newer one.',
  ]);

  return table(['Not covered', 'What that means'], rows);
}

/**
 * Every generated block, keyed by the name in its marker.
 *
 * @param {{ record: JourneyRecord | null, assistive: AssistiveRecord | null, ci: boolean | null }} evidence
 * @returns {Map<string, string>}
 */
export function sections(evidence) {
  return new Map([
    ['browsers-matrix', matrixSection(evidence.record)],
    ['browsers-journey', journeySection(evidence.record)],
    ['browsers-assistive', assistiveSection(evidence.assistive)],
    ['browsers-limits', limitsSection(evidence.record, evidence.assistive, evidence.ci)],
  ]);
}

/**
 * @returns {Promise<{ record: JourneyRecord | null, assistive: AssistiveRecord | null, ci: boolean | null }>}
 */
export async function readEvidence() {
  return {
    record: /** @type {JourneyRecord | null} */ (await readJson(RECORD)),
    assistive: /** @type {AssistiveRecord | null} */ (await readJson(ASSISTIVE)),
    ci: await automated(),
  };
}

/**
 * @param {{ file?: string, write?: boolean, evidence?: Awaited<ReturnType<typeof readEvidence>> }} [options]
 * @returns {Promise<{ diagnostics: import('../../cli/diagnostics/types.js').Diagnostic[], drifted: string[], text: string | null }>}
 */
export async function checkBrowserGuide(options = {}) {
  const file = options.file ?? join(REPO, DEFAULT_TARGET);
  const text = await readText(file);
  const write = options.write === true;
  const evidence = options.evidence ?? (await readEvidence());
  const { out, drifted, diagnostics } = rewriteGenerated(text, sections(evidence), {
    file,
    write,
    command: 'npm run docs:browsers:write',
  });
  if (write && out !== null && out !== text) await writeFile(file, out, 'utf8');
  return { diagnostics, drifted, text: out };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const write = process.argv.includes('--write');
  const index = process.argv.indexOf('--file');
  const file = index === -1 ? undefined : process.argv[index + 1];

  const { diagnostics } = await checkBrowserGuide({ file, write });
  process.exitCode = report(diagnostics, {
    format: outputFormat(),
    summary: `The generated sections of ${file ?? DEFAULT_TARGET} come from the recorded journey run.`,
  });
}
