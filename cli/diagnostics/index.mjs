/**
 * One finding, one shape, two adapters.
 *
 * Every check here returns `Diagnostic[]` and prints nothing. This module is what
 * turns that list into output: a terminal report for a person, and a JSON
 * document for CI, an editor or an agent. A check that formatted its own findings
 * would be a second copy of the wording, the indentation and the exit-code rule,
 * and — the reason this exists at all — a finding nothing but a terminal could
 * read. ADR-0072.
 *
 * The text adapter writes progress to stdout and refusals to stderr, because that
 * split is what lets a CI log be read for the failures alone. The JSON adapter
 * writes one document to stdout and nothing to stderr, because a consumer parsing
 * it wants one stream.
 */

import { isAbsolute } from 'node:path';

import { repoPath } from '../layout.mjs';

/** @import { Counts, Diagnostic, Severity, TextReport, Where } from './types.js' */

/**
 * The terminal label for each severity, and the width they are padded to.
 *
 * The vocabulary is the one this repository's checks already printed by hand —
 * `ok`, `note`, `FAIL` — so the report reads the same after the findings became
 * values as it did before.
 */
const LABELS = /** @type {Record<Severity, string>} */ ({
  error: 'FAIL',
  warning: 'note',
  info: 'ok',
});

const LABEL_WIDTH = 5;

/**
 * A path as a diagnostic states it: repository-relative and `/`-separated, or
 * absolute when the file is outside the repository.
 *
 * A check that has an absolute path should hand it over as-is rather than
 * shortening it first. Doing it here is what keeps one answer to "how is a path
 * spelled in a report" instead of one `show()` helper per check, which is what
 * this repository had.
 *
 * @param {string | null | undefined} file
 * @returns {string | null}
 */
function normalizeFile(file) {
  if (file === undefined || file === null || file === '') return null;
  if (!isAbsolute(file)) return file;
  const inside = repoPath(file);
  return inside.startsWith('..') ? file : inside;
}

/**
 * @param {Severity} severity
 * @param {string} code
 * @param {string} message
 * @param {Where} [where]
 * @returns {Diagnostic}
 */
function make(severity, code, message, where = {}) {
  return {
    severity,
    code,
    message,
    group: where.group ?? null,
    file: normalizeFile(where.file),
    line: where.line ?? null,
    column: where.column ?? null,
  };
}

/**
 * A refusal. The command exits non-zero because of it.
 *
 * @param {string} code @param {string} message @param {Where} [where] @returns {Diagnostic}
 */
export function error(code, message, where) {
  return make('error', code, message, where);
}

/**
 * Reported, and not a refusal: a locale at 60%, a coverage gap the run should say
 * out loud rather than let a reader assume away.
 *
 * @param {string} code @param {string} message @param {Where} [where] @returns {Diagnostic}
 */
export function warning(code, message, where) {
  return make('warning', code, message, where);
}

/**
 * A check that ran and passed, kept as a value for the same reason a failure is:
 * "the import map was compared verbatim" is an assertion a caller should be able
 * to make without reading terminal output.
 *
 * @param {string} code @param {string} message @param {Where} [where] @returns {Diagnostic}
 */
export function info(code, message, where) {
  return make('info', code, message, where);
}

/** @param {readonly Diagnostic[]} diagnostics @returns {Counts} */
export function counts(diagnostics) {
  const found = { error: 0, warning: 0, info: 0 };
  for (const diagnostic of diagnostics) found[diagnostic.severity] += 1;
  return found;
}

/** @param {readonly Diagnostic[]} diagnostics @returns {boolean} */
export function hasErrors(diagnostics) {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}

/**
 * Every error, in order. What a test asserts on when it cares about refusals and
 * not about the twenty things that passed on the way.
 *
 * @param {readonly Diagnostic[]} diagnostics
 * @returns {Diagnostic[]}
 */
export function errors(diagnostics) {
  return diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
}

/**
 * `file:line:column`, as much of it as the diagnostic has. Empty when it names no
 * file.
 *
 * @param {Diagnostic} diagnostic
 * @returns {string}
 */
function position(diagnostic) {
  if (diagnostic.file === null) return '';
  if (diagnostic.line === null) return diagnostic.file;
  if (diagnostic.column === null) return `${diagnostic.file}:${String(diagnostic.line)}`;
  return `${diagnostic.file}:${String(diagnostic.line)}:${String(diagnostic.column)}`;
}

/**
 * Where a refusal happened, for a block that carries no headings: the file, or the
 * group when the finding names no file.
 *
 * @param {Diagnostic} diagnostic
 * @returns {string}
 */
function where(diagnostic) {
  const place = position(diagnostic);
  return place === '' ? (diagnostic.group ?? '') : place;
}

/**
 * One progress line. The group is the heading above it, so it is not repeated
 * here; the file is, because a passing check that names a file is naming which one.
 *
 * @param {Diagnostic} diagnostic
 * @returns {string}
 */
function line(diagnostic) {
  const place = position(diagnostic);
  const label = LABELS[diagnostic.severity].padEnd(LABEL_WIDTH);
  return `  ${label}${place === '' ? '' : `${place}: `}${diagnostic.message}`;
}

/**
 * The terminal report, as the two streams it belongs on.
 *
 * Progress — everything that passed and everything worth saying that is not a
 * refusal — goes to stdout in the order it was found, under a heading whenever
 * the group changes. Refusals are repeated to stderr as one block at the end,
 * because a run that reported the first failure where it happened and nothing
 * afterwards is a run somebody has to repeat once per failure.
 *
 * @param {readonly Diagnostic[]} diagnostics
 * @param {{ title?: string, summary?: string }} [options]
 *   `title` heads the report; `summary` is the one line printed when nothing
 *   failed, and is the check's to word because it says what was covered.
 * @returns {TextReport}
 */
export function formatText(diagnostics, options = {}) {
  /** @type {string[]} */
  const out = [];
  if (options.title !== undefined) out.push(options.title);

  /** @type {string | null | undefined} */
  let group;
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === 'error') continue;
    if (diagnostic.group !== group) {
      group = diagnostic.group;
      if (group !== null) out.push('', group);
    }
    out.push(line(diagnostic));
  }

  const refusals = errors(diagnostics);
  if (refusals.length === 0 && options.summary !== undefined) out.push('', options.summary);

  /** @type {string[]} */
  const err = [];
  if (refusals.length > 0) {
    err.push('', `${String(refusals.length)} problem(s):`, '');
    for (const diagnostic of refusals) {
      const place = where(diagnostic);
      err.push(`  - ${place === '' ? '' : `${place}: `}${diagnostic.message}`, '');
    }
  }

  return {
    out: out.length === 0 ? '' : `${out.join('\n')}\n`,
    err: err.length === 0 ? '' : `${err.join('\n')}\n`,
  };
}

/**
 * The whole run as one document.
 *
 * `ok` and `counts` are stated rather than left to be derived, so a consumer that
 * only wants the verdict does not have to know that `error` is the severity that
 * fails.
 *
 * @param {readonly Diagnostic[]} diagnostics
 * @returns {string}
 */
export function formatJson(diagnostics) {
  return `${JSON.stringify(
    { ok: !hasErrors(diagnostics), counts: counts(diagnostics), diagnostics },
    null,
    2,
  )}\n`;
}

/**
 * Which adapter a command line asked for.
 *
 * One flag, and it is the same flag on every check, which is the point of the
 * findings being values: `--json` costs each check nothing.
 *
 * @param {readonly string[]} [argv]
 * @returns {'text' | 'json'}
 */
export function outputFormat(argv = process.argv) {
  return argv.includes('--json') ? 'json' : 'text';
}

/**
 * Print a run and answer with its exit code.
 *
 * The only thing in this module that writes. A command block is then one line,
 * and the exit-code rule — errors fail, warnings do not — is stated once.
 *
 * @param {readonly Diagnostic[]} diagnostics
 * @param {{
 *   title?: string,
 *   summary?: string,
 *   format?: 'text' | 'json',
 *   out?: (text: string) => void,
 *   err?: (text: string) => void,
 * }} [options]
 * @returns {number} the process exit code
 */
export function report(diagnostics, options = {}) {
  const out = options.out ?? ((text) => process.stdout.write(text));
  const err = options.err ?? ((text) => process.stderr.write(text));

  if ((options.format ?? outputFormat()) === 'json') {
    out(formatJson(diagnostics));
  } else {
    const text = formatText(diagnostics, options);
    if (text.out !== '') out(text.out);
    if (text.err !== '') err(text.err);
  }

  return hasErrors(diagnostics) ? 1 : 0;
}
