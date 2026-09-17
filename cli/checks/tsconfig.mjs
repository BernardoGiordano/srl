/**
 * The repository's root `tsconfig.json`, read one way for both compiler checks.
 *
 * The type check and the template check compile against the same options and the same
 * JSDoc types. A missing file is setup rather than a finding, and both checks explain it
 * with the message below.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

import { REPO } from '../layout.mjs';

export const TSCONFIG = resolve(REPO, 'tsconfig.json');

const MISSING =
  `No tsconfig.json at ${REPO}.\n\n` +
  `srl check compiles the JavaScript and every template against the options and JSDoc ` +
  `types this file describes. That includes the path mappings that make \`@core/\` ` +
  `resolve, which tsc cannot read from an import map.\n\n` +
  `Extend the one the library publishes:\n\n` +
  `  {\n` +
  `    "extends": "@srljs/core/tsconfig.base.json",\n` +
  `    "include": ["<app>/**/*.js"]\n` +
  `  }\n`;

/**
 * The parsed configuration.
 *
 * `error` is set when the file is not valid JSON, and then nothing else is usable.
 * `errors` holds what TypeScript reports about the options, which `tsc` prints before
 * any source finding.
 *
 * @returns {{
 *   options: ts.CompilerOptions,
 *   fileNames: string[],
 *   error: ts.Diagnostic | undefined,
 *   errors: readonly ts.Diagnostic[],
 * }}
 * @throws {Error} when the file does not exist, with the fix in the message
 */
export function readTsconfig() {
  if (!existsSync(TSCONFIG)) throw new Error(MISSING);

  const config = ts.readConfigFile(TSCONFIG, (file) => ts.sys.readFile(file));
  if (config.error !== undefined) {
    return { options: {}, fileNames: [], error: config.error, errors: [] };
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, REPO, undefined, TSCONFIG);
  return {
    options: parsed.options,
    fileNames: parsed.fileNames,
    error: undefined,
    errors: parsed.errors,
  };
}
