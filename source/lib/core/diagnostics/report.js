/**
 * An update report as text, which is the one adapter there is.
 *
 * A console is where a developer already is when they ask why something updated,
 * and a string is the form every other destination can still take — a test
 * assertion, a bug report, a file. A second inspection surface (a panel, a
 * protocol) is a real module when a real consumer needs one; until then this is
 * the whole of the presentation layer, and it reads the report rather than the
 * recorder. ADR-0109.
 */

/** @import { UpdateRecord, UpdateReport } from '@core/diagnostics/types.js' */

/** How many timeline lines to print before eliding the rest. */
const DEFAULT_RECORDS = 200;

/**
 * @typedef {object} FormatOptions
 * @property {number} [records] Timeline lines to print. Defaults to 200.
 */

/**
 * Render a report: two summaries, then the timeline that produced them.
 *
 * The summaries come first because they answer the question that is usually
 * being asked — which component and which binding did the work — and the
 * timeline below them is where the order and the nesting are read.
 *
 * @param {UpdateReport} report
 * @param {FormatOptions} [options]
 * @returns {string}
 */
export function formatUpdateReport(report, options) {
  const limit = options?.records ?? DEFAULT_RECORDS;
  const lines = [
    `srl updates — ${ms(report.durationMs)} ms, ` +
      `${plural(report.elements.length, 'tag')}, ${plural(report.bindings.length, 'binding')}`,
  ];

  lines.push('', 'Elements', '  updates  total ms  tag');
  for (const entry of report.elements) {
    lines.push(`  ${pad(entry.updates, 7)}  ${pad(ms(entry.durationMs), 8)}  ${entry.name}`);
  }
  if (report.elements.length === 0) lines.push('  nothing rendered');

  lines.push('', 'Bindings', '  updates  changed  total ms  binding');
  for (const entry of report.bindings) {
    lines.push(
      `  ${pad(entry.updates, 7)}  ${pad(entry.changed, 7)}  ` +
        `${pad(ms(entry.durationMs), 8)}  ${entry.name}`,
    );
  }
  if (report.bindings.length === 0) lines.push('  nothing evaluated');

  lines.push('', 'Timeline (ms from start)');
  const budget = { left: limit, elided: 0 };
  for (const record of report.records) timeline(record, 0, budget, lines);
  if (report.records.length === 0) lines.push('  nothing updated');
  if (budget.elided > 0) lines.push(`  ...and ${String(budget.elided)} more`);

  if (report.dropped > 0) {
    lines.push(
      '',
      `${String(report.dropped)} records were not retained: the recording hit its limit. ` +
        `The summaries above still count them.`,
    );
  }

  return lines.join('\n');
}

/**
 * @param {UpdateRecord} record
 * @param {number} depth
 * @param {{ left: number, elided: number }} budget
 * @param {string[]} lines
 */
function timeline(record, depth, budget, lines) {
  if (budget.left <= 0) {
    budget.elided += 1;
  } else {
    budget.left -= 1;
    lines.push(`  ${pad(ms(record.at), 8)}  ${'  '.repeat(depth)}${describe(record)}`);
  }
  if (record.kind !== 'element') return;
  for (const child of record.children) timeline(child, depth + 1, budget, lines);
}

/**
 * @param {UpdateRecord} record
 * @returns {string}
 */
function describe(record) {
  if (record.kind === 'element') {
    const properties =
      record.properties.length > 0 ? ` [${record.properties.join(', ')}]` : '';
    return `<${record.tag}> ${record.cause}${properties}, ${ms(record.durationMs)} ms`;
  }
  const changed = record.changed ? ', changed' : '';
  return `${record.binding} ${record.cause}, ${ms(record.durationMs)} ms${changed}`;
}

/**
 * @param {number} value
 * @returns {string}
 */
function ms(value) {
  return value.toFixed(2);
}

/**
 * @param {number} count
 * @param {string} noun Regular plural, which is all this file needs.
 * @returns {string}
 */
function plural(count, noun) {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * @param {string | number} value
 * @param {number} width
 * @returns {string}
 */
function pad(value, width) {
  return String(value).padStart(width, ' ');
}
