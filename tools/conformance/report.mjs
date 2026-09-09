/**
 * One parity report over every installed editor a run could drive. ADR-0097.
 *
 * The point of the table is the column that is empty: a scenario VS Code answers and
 * WebStorm cannot is a real difference between what the two plugins are known to do, and
 * it should be visible rather than implied by which workflow happened to run.
 */

import { error, info, warning } from '../../cli/diagnostics/index.mjs';

/** @import { Diagnostic } from '../../cli/diagnostics/types.js' */
/** @import { AdapterRun, Scenario } from './types.js' */

const GROUP = 'editor conformance';

/** @param {AdapterRun} run */
const column = (run) => `${run.adapter} ${run.edition}`;

/**
 * The table, as Markdown, so CI can keep it as an artifact and a reader can diff two.
 *
 * @param {AdapterRun[]} runs
 * @param {Scenario[]} scenarios
 * @returns {string}
 */
export function parity(runs, scenarios) {
  const columns = runs.map(column);
  const lines = [
    '# Editor conformance',
    '',
    ...runs.map((run) => `- **${column(run)}** — ${run.version}`),
    '',
    `| Scenario | ${columns.join(' | ')} |`,
    `| --- | ${columns.map(() => '---').join(' | ')} |`,
  ];

  for (const scenario of scenarios) {
    const cells = runs.map((run) => {
      const found = run.results.find((result) => result.id === scenario.id);
      if (found === undefined) return 'not asked';
      return found.status === 'pass' ? 'pass' : found.status === 'fail' ? '**fail**' : 'n/a';
    });
    lines.push(`| \`${scenario.id}\` | ${cells.join(' | ')} |`);
  }

  lines.push('', '## What each scenario asks', '');
  for (const scenario of scenarios) lines.push(`- \`${scenario.id}\` — ${scenario.title}`);

  const explained = runs.flatMap((run) =>
    run.results
      .filter((result) => result.status !== 'pass' && result.detail !== '')
      .map((result) => `- \`${result.id}\` in ${column(run)}: ${result.detail}`),
  );
  if (explained.length > 0) lines.push('', '## Why', '', ...explained);

  return `${lines.join('\n')}\n`;
}

/**
 * What the run found, as findings: a failure is a refusal, an editor nobody could drive
 * is a warning, and each editor that ran says how much of the list it answered.
 *
 * @param {AdapterRun[]} runs
 * @returns {Diagnostic[]}
 */
export function findings(runs) {
  /** @type {Diagnostic[]} */
  const found = [];
  for (const run of runs) {
    const passed = run.results.filter((result) => result.status === 'pass');
    const failed = run.results.filter((result) => result.status === 'fail');
    const missing = run.results.filter((result) => result.status === 'unavailable');

    for (const result of failed) {
      found.push(
        error('conformance/scenario', `${column(run)}: ${result.id} — ${result.detail}`, { group: GROUP }),
      );
    }

    if (passed.length === 0 && failed.length === 0) {
      found.push(
        warning(
          'conformance/editor-unavailable',
          `${column(run)} answered nothing: ${missing[0]?.detail ?? 'no reason given'}`,
          { group: GROUP },
        ),
      );
      continue;
    }

    found.push(
      info(
        'conformance/editor',
        `${column(run)} (${run.version}): ${String(passed.length)} passed, ${String(failed.length)} failed, ` +
          `${String(missing.length)} not answerable`,
        { group: GROUP },
      ),
    );
  }
  return found;
}
