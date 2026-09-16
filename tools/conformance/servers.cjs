'use strict';

/**
 * The language servers this machine is running, by the project each was started for.
 * ADR-0097.
 *
 * Started processes are the one piece of session state an editor cannot fake. A window
 * that says it is serving a folder and holds no process for it is not, and one that
 * holds two has leaked the first. CommonJS because both sides read it, the driver by
 * `createRequire` and the probe inside the extension host by `require`.
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');

/** The path fragment every srl server is started with. */
const MARKER = path.join('language-server', 'server.mjs');

/**
 * @param {Record<string, string>} roots project directories, by name
 * @returns {{ byRoot: Record<string, number>, total: number }}
 */
function census(roots) {
  const lines = execFileSync('ps', ['-Ao', 'pid=,args='], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.includes(MARKER));

  /** @type {Record<string, number>} */
  const byRoot = {};
  let total = 0;
  for (const line of lines) {
    for (const [name, root] of Object.entries(roots)) {
      if (!line.includes(`${root}${path.sep}`)) continue;
      byRoot[name] = (byRoot[name] ?? 0) + 1;
      total += 1;
    }
  }
  return { byRoot, total };
}

module.exports = { MARKER, census };
