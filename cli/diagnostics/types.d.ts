/**
 * What a check found, in one declaration.
 *
 * Every check in this toolchain used to answer "what is wrong" by writing to a
 * terminal: `console.error` at the point of discovery and a count as the return
 * value. That makes the finding unreachable — a test can assert that six things
 * were wrong and not which six, an editor has nothing to underline, and an agent
 * has nothing to read. The count crossed the function boundary; the finding did
 * not.
 *
 * A `Diagnostic` is the finding as a value. `cli/diagnostics/index.mjs` is the
 * only thing that formats one, so a check states what it found and never how it
 * is printed. ADR-0072.
 */

/**
 * How much a finding matters.
 *
 * `error` is a refusal: the command exits non-zero. `warning` is reported and
 * does not fail — an untranslated locale, a coverage gap a run should say out
 * loud. `info` is a check that ran and passed, kept as a value for the same
 * reason a failure is: a caller that wants to know the import map was compared
 * verbatim should not have to parse a line of terminal output to find out.
 */
export type Severity = 'error' | 'warning' | 'info';

/** One finding. */
export interface Diagnostic {
  severity: Severity;
  /**
   * A stable identifier for the kind of finding, namespaced by the check that
   * produces it: `deps/undeclared-specifier`, `templates/ts2339`. Wording
   * changes; this does not, so it is what a test, a filter or a suppression
   * names.
   */
  code: string;
  /** One human sentence, or several lines when the remedy needs them. */
  message: string;
  /**
   * The subject the finding belongs to — an application name, `library`,
   * `toolchain` — or null when it belongs to the repository as a whole. The text
   * adapter uses it as a heading; a JSON consumer uses it to group.
   */
  group: string | null;
  /**
   * A repository-relative, `/`-separated path, or an absolute one when the file
   * is outside the repository. Null when the finding is about no single file.
   */
  file: string | null;
  /** 1-based. Null when the finding is about the whole file. */
  line: number | null;
  /** 1-based. Null when the finding is about the whole line. */
  column: number | null;
}

/** Where a finding is, as a caller states it. Any part may be omitted. */
export interface Where {
  group?: string | null;
  /** Absolute or repository-relative; an absolute path inside the repository is shortened. */
  file?: string | null;
  line?: number | null;
  column?: number | null;
}

/** How many of each severity a list holds. */
export interface Counts {
  error: number;
  warning: number;
  info: number;
}

/** The two streams the text adapter writes: progress to stdout, refusals to stderr. */
export interface TextReport {
  out: string;
  err: string;
}
