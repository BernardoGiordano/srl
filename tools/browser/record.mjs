/**
 * Run the journey on every declared engine and write down what it proved.
 *
 *   node tools/browser/record.mjs            record every declared engine
 *   node tools/browser/record.mjs --engine webkit   one of them
 *
 * WHY A RECORD EXISTS AT ALL
 *
 * The suite in `cli/test/browser-journey.test.mjs` fails a pull request. It cannot publish
 * anything: a passing suite leaves behind the word "passed" and no browser version, no
 * step list and no statement of what was never run. A support matrix assembled from that
 * is a matrix assembled from memory, which is how "we support Safari" survives two years
 * after anybody last opened it.
 *
 * So the same journey is run here and its readings are written to `journeys.json`, which
 * `tools/checks/browser-check.mjs` turns into the published table. The file carries the
 * engine versions, the machine, the date, and every step's own observations — a reader who
 * wants to know what "passed" meant can see the numbers it meant.
 *
 * A recorded run is evidence of that run, and nothing else. It is not a gate, it does not
 * replace the suite, and re-recording after a change to the journey is the normal thing to
 * do. `npm run docs:browsers` fails when the guide disagrees with the file, so the two
 * cannot drift; nothing fails when the file itself is older than the code, which is why
 * the guide prints the date.
 */

import { createRequire } from 'node:module';
import { arch, cpus, release, type as osType } from 'node:os';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { REPO } from '../../cli/layout.mjs';
import { ENGINES, engineById, openEngine } from '../../cli/test/support/journey/engines.mjs';
import { runJourney } from '../../cli/test/support/journey/journey.mjs';
import { stageArtifact } from '../../cli/test/support/journey/stage.mjs';

/** @import { JourneyRecord } from './types.js' */

export const RECORD_FILE = join(REPO, 'tools/browser/journeys.json');

/** The application the journey is written against. */
const APP = 'example';

/**
 * @param {readonly string[]} argv
 * @returns {Promise<JourneyRecord>}
 */
export async function record(argv = []) {
  const only = argv.includes('--engine') ? argv[argv.indexOf('--engine') + 1] : undefined;
  const engines = only === undefined ? ENGINES : [engineById(only)];

  const stage = await stageArtifact(APP);
  /** @type {JourneyRecord['engines']} */
  const results = [];
  try {
    for (const engine of engines) {
      const driver = await openEngine(engine, stage.url);
      const started = Date.now();
      try {
        const steps = await runJourney(driver);
        results.push({
          id: engine.id,
          title: engine.title,
          engine: engine.engine,
          version: driver.version,
          nextControl: engine.nextControl,
          outcome: 'passed',
          durationMs: Date.now() - started,
          steps: steps.map((step) => ({ id: step.id, title: step.title, observed: step.observed })),
        });
      } catch (cause) {
        results.push({
          id: engine.id,
          title: engine.title,
          engine: engine.engine,
          version: driver.version,
          nextControl: engine.nextControl,
          outcome: 'failed',
          durationMs: Date.now() - started,
          failure: cause instanceof Error ? cause.message : String(cause),
          steps: [],
        });
      } finally {
        await driver.close();
      }
    }
  } finally {
    await stage.close();
  }

  return {
    recordedAt: new Date().toISOString().slice(0, 10),
    app: APP,
    csp: stagedPolicy(stage.csp),
    machine: {
      platform: osType(),
      release: release(),
      arch: arch(),
      cpu: cpus()[0]?.model.trim() ?? 'unknown',
      node: process.version,
    },
    driver: { name: 'playwright', version: playwrightVersion() },
    engines: results,
  };
}

/**
 * The policy the journey ran under, as one line. Kept in the record because "under the
 * artifact's own CSP" is half the claim, and a policy that quietly loosened would
 * otherwise leave the matrix reading exactly the same.
 *
 * @param {string} csp
 * @returns {string}
 */
function stagedPolicy(csp) {
  return csp.replace(/\s+/gu, ' ').trim();
}

/** @returns {string} */
function playwrightVersion() {
  return /** @type {{ version: string }} */ (
    createRequire(import.meta.url)('playwright/package.json')
  ).version;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const written = await record(process.argv.slice(2));
  await writeFile(RECORD_FILE, `${JSON.stringify(written, null, 2)}\n`, 'utf8');
  const failed = written.engines.filter((engine) => engine.outcome === 'failed');
  for (const engine of written.engines) {
    console.log(`${engine.outcome === 'passed' ? 'ok  ' : 'FAIL'} ${engine.title.padEnd(9)} ${engine.version}`);
  }
  console.log(`\nWrote tools/browser/journeys.json. Run \`npm run docs:browsers:write\` to publish it.`);
  if (failed.length > 0) process.exitCode = 1;
}
