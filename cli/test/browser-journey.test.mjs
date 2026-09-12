/**
 * The supported-browser claim, exercised rather than configured.
 *
 * One journey, three engines, one built artifact under its own security policy. The
 * journey itself is `support/journey/journey.mjs` and is written once; what this file adds
 * is the staging, the loop, and the refusal to let an engine quietly not run — an engine
 * declared in `ENGINES` and skipped here would turn the support matrix back into a list of
 * names, which is the state ADR-0116 exists to leave.
 *
 * Slow on purpose. It builds the artifact once and drives it three times, which is the
 * cost of a claim about three engines.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ENGINES, openEngine } from './support/journey/engines.mjs';
import { runJourney } from './support/journey/journey.mjs';
import { stageArtifact } from './support/journey/stage.mjs';

/** Building the artifact and driving three browsers does not fit the default timeout. */
const TIMEOUT_MS = 300_000;

void test(
  'one accessible interaction journey runs on every supported engine',
  { timeout: TIMEOUT_MS },
  async (t) => {
    const stage = await stageArtifact('example');
    try {
      for (const engine of ENGINES) {
        await t.test(`${engine.title} (${engine.engine})`, async () => {
          const driver = await openEngine(engine, stage.url);
          try {
            const steps = await runJourney(driver);
            assert.ok(steps.length > 0, 'the journey must report what it proved');
          } finally {
            await driver.close();
          }
        });
      }
    } finally {
      await stage.close();
    }
  },
);
