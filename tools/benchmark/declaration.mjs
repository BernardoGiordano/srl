/**
 * What an application declares about its own artifact benchmarks.
 *
 * The delivery workloads walk one application's lazy routes and talk to one
 * application's backend. Both are that application's facts, so the harness reads them
 * from `<app>/benchmark.json` rather than holding a table that names somebody's
 * screens:
 *
 *   {
 *     "backend": "test/fake-server.js",
 *     "lazyRoutes": [{ "id": "home", "path": "/", "tag": "home-page" }],
 *     "staleReleaseRoute": { "path": "/settings", "tag": "settings-page",
 *                            "module": "<app>/src/pages/settings-page.js" }
 *   }
 *
 * Opt-in, and silent when absent: an application that ships no declaration contributes
 * no artifact workloads and gets no fake backend behind its origin. That is what keeps
 * one application's route names out of another's numbers, and it is why adding the
 * second artifact pilot is a file in that application rather than an edit here.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** @import { ArtifactDeclaration } from './types.js' */

/** The file an application declares its artifact benchmarks in. */
export const DECLARATION_FILE = 'benchmark.json';

/**
 * @param {{ name: string, dir: string }} app
 * @returns {ArtifactDeclaration | null}
 */
export function artifactDeclaration(app) {
  const file = join(app.dir, DECLARATION_FILE);
  if (!existsSync(file)) return null;
  const declared = /** @type {ArtifactDeclaration} */ (JSON.parse(readFileSync(file, 'utf8')));
  return { ...declared, app: app.name };
}
