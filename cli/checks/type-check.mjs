/**
 * The repository's JavaScript, typechecked the way `tsc --noEmit` checks it.
 *
 *   node cli/checks/type-check.mjs [--json]
 *
 * One program over the root tsconfig.json, with that file's own options, so a finding
 * here is a finding `tsc` reports. The template check reads the same file and relaxes
 * the unused-name rules for the code it generates, so the two checks build separate
 * programs.
 *
 * The TypeScript error number becomes the code, as it does for templates, because the
 * number is stable and TypeScript rewords the sentence beside it. ADR-0072.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

import { error, info, outputFormat, report, warning } from '../diagnostics/index.mjs';
import { readTsconfig } from './tsconfig.mjs';

/** @import { Diagnostic } from '../diagnostics/types.js' */

/**
 * A compiler diagnostic as a finding of this check.
 *
 * @param {ts.Diagnostic} diagnostic
 * @returns {Diagnostic}
 */
function fromCompiler(diagnostic) {
  const make = diagnostic.category === ts.DiagnosticCategory.Error ? error : warning;
  const code = `types/ts${String(diagnostic.code)}`;
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  if (diagnostic.file === undefined) return make(code, message);
  const where = { file: diagnostic.file.fileName };
  if (diagnostic.start === undefined) return make(code, message, where);
  const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return make(code, message, { ...where, line: line + 1, column: character + 1 });
}

/**
 * Every type error in the files the root tsconfig.json includes.
 *
 * @returns {Diagnostic[]}
 */
export function checkTypes() {
  let config;
  try {
    config = readTsconfig();
  } catch (cause) {
    return [error('types/no-config', cause instanceof Error ? cause.message : String(cause))];
  }
  if (config.error !== undefined) return [fromCompiler(config.error)];

  const program = ts.createProgram({
    rootNames: config.fileNames,
    options: { ...config.options, noEmit: true },
    configFileParsingDiagnostics: config.errors,
  });
  const found = ts.getPreEmitDiagnostics(program).map(fromCompiler);

  if (!found.some((diagnostic) => diagnostic.severity === 'error')) {
    found.push(
      info('types/checked', `${String(config.fileNames.length)} file(s) typechecked against tsconfig.json`),
    );
  }
  return found;
}

/* ── As a command ──────────────────────────────────────────────────────────
 *
 * Guarded, so importing this module stays free of output and exit codes.
 */

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = report(checkTypes(), {
    format: outputFormat(),
    summary: 'Every file tsconfig.json includes typechecks.',
  });
}
