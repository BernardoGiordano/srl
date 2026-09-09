/**
 * What an installed editor actually does with an installed project. ADR-0097.
 *
 *   node tools/conformance/conformance.mjs [--webstorm] [--edition <name>]
 *                                          [--only <id,id>] [--report <path>]
 *
 * Packaging proves the artifact's layout and the Plugin Verifier proves the plugin loads.
 * Neither proves that installing it makes an editor start the project's own toolchain and
 * answer with it. This installs the packed extension into a real editor, drives the
 * shared scenarios through the editor's own providers, and writes one parity report over
 * every editor it could reach.
 *
 * VS Code runs by default, at the minimum version `engines.vscode` claims and at current
 * stable. WebStorm needs an installed, licensed IDE, so it is opt-in: `--webstorm`.
 */

import { writeFile } from 'node:fs/promises';

import { hasErrors, info, outputFormat, report } from '../../cli/diagnostics/index.mjs';
import { build, remove } from './fixture.mjs';
import { findings, parity } from './report.mjs';
import { SCENARIOS, only } from './scenarios.mjs';
import * as vscode from './vscode.mjs';
import * as webstorm from './webstorm.mjs';

/** @import { AdapterRun } from './types.js' */

const GROUP = 'editor conformance';

/**
 * @param {string[]} argv
 * @returns {Promise<{ diagnostics: import('../../cli/diagnostics/types.js').Diagnostic[], parity: string }>}
 */
export async function conform(argv) {
  const chosen = argv.includes('--only') ? only(String(argv[argv.indexOf('--only') + 1]).split(',')) : SCENARIOS;
  if (chosen.length === 0) throw new Error('--only named no scenario that exists');

  const adapters = [vscode, ...(argv.includes('--webstorm') ? [webstorm] : [])];
  const editions = argv.includes('--edition') ? [String(argv[argv.indexOf('--edition') + 1])] : undefined;

  const fixture = await build();
  /** @type {AdapterRun[]} */
  const runs = [];
  try {
    for (const adapter of adapters) {
      runs.push(...(await adapter.drive(fixture, chosen, { editions })));
    }
  } finally {
    if (argv.includes('--keep')) runs.push();
    else await remove(fixture);
  }

  return {
    diagnostics: [
      info('conformance/fixture', `${String(chosen.length)} scenario(s) over ${String(runs.length)} editor(s)`, {
        group: GROUP,
      }),
      ...findings(runs),
    ],
    parity: parity(runs, chosen),
  };
}

const found = await conform(process.argv.slice(2));

const at = process.argv.indexOf('--report');
if (at !== -1) await writeFile(String(process.argv[at + 1]), found.parity);
else if (!hasErrors(found.diagnostics)) process.stdout.write(`\n${found.parity}`);

process.exitCode = report(found.diagnostics, {
  format: outputFormat(),
  summary: 'Every installed editor answers the scenarios its platform allows.',
});
