/**
 * Application startup.
 *
 * Startup runs in a fixed order: fetch the manifest, warm the template cache, load the
 * locale, install providers, settle the session, then define the root element. Getting
 * the order wrong doesn't throw. It flashes untranslated text, or bounces a deep link to
 * the login page because a guard ran before the session was restored.
 *
 * The library owns the order, and the application supplies hooks for the decisions only
 * it can make. Hooks receive the admitted manifest.
 *
 * A failure inside a step is rethrown as `ApplicationStartupError` naming the step, with
 * the original error as `cause`, so a blank page points at the step that failed.
 */

import { configureI18n } from '@core/localization/i18n.js';
import { loadManifest, useManifest } from '@core/remotes/mfe.js';
import { defineTag } from '@core/elements/mount.js';
import { readJson } from '@core/foundation/json.js';
import {
  prefetchTemplates,
  registerTemplateGroups,
  seedTemplates,
} from '@core/template/template.js';

/** @import { ApplicationRoot, ApplicationSpec, StartedApplication, StartupStep, StartupStepRun } from '@core/application/types.js' */
/** @import { AppManifest } from '@core/remotes/types.js' */

/**
 * Prefix of the User Timing measure each step emits.
 *
 * Regressions happen inside a step and hide in the total. Each step reports its duration
 * on the returned `steps` and as a measure, so the performance panel, field beacons and
 * the benchmark can read it without holding the return value.
 */
export const STARTUP_MEASURE = 'srl:startup:';

/**
 * A step of startup failed. `step` names which one, `cause` is what went wrong.
 */
export class ApplicationStartupError extends Error {
  /** @type {StartupStep} */
  step;

  /**
   * @param {StartupStep} step
   * @param {unknown} cause
   */
  constructor(step, cause) {
    super(`Application startup failed at step "${step}": ${describe(cause)}`, { cause });
    this.name = 'ApplicationStartupError';
    this.step = step;
  }
}

/**
 * Boot an application.
 *
 * Steps run in this order, and each is skipped when the application doesn't use it.
 *
 *   1. `configure`   Synchronous setup that must come first, typically
 *                    `configureTheme()`.
 *   2. `manifest`    Fetch, admit and install `app.manifest.json`. Remote locations,
 *                    the API base and the locale settings all come from it.
 *   3. `templates`   Seed the template cache from `templateBundle`, or start the entry
 *                    group of `templateGroups` (or all of a flat `templateFiles`).
 *                    Other groups start with their chunk.
 *   4. `locale`      Await `configureI18n`, so nothing renders untranslated.
 *   5. `providers`   Install injection providers, most of them configured from the
 *                    manifest.
 *   6. `ready`       Settle what the first route must not race, such as a session
 *                    restore.
 *   7. `root`        Import the root element's module and verify that it defined the
 *                    element. Components start rendering here.
 *
 * The root module is imported dynamically, because a static import would evaluate
 * before any step runs.
 *
 * Every step that runs reports its duration on `steps` and as a `srl:startup:<step>`
 * User Timing measure.
 *
 * @param {ApplicationSpec} spec
 * @returns {Promise<StartedApplication>}
 */
export async function startApplication(spec) {
  /** @type {StartupStepRun[]} */
  const steps = [];

  const { configure, providers, ready, root } = spec;

  if (configure !== undefined) await step('configure', steps, configure);

  const manifest = await step('manifest', steps, async () => {
    const value = spec.manifest ?? (await loadManifest(spec.manifestUrl));
    useManifest(value);
    return value;
  });

  // A bundle wins over prefetching, since it already holds the markup.
  const bundle = manifest.templateBundle;
  if (bundle !== undefined) {
    await step('templates', steps, () => seedTemplateBundle(bundle));
  } else if (manifest.templateFiles.length > 0) {
    await step('templates', steps, () => {
      // Register the groups before starting the entry group, so starting it marks it
      // started and its first component doesn't start it again.
      registerTemplateGroups(manifest.templateGroups);
      prefetchTemplates(entryTemplates(manifest));
    });
  }

  await step('locale', steps, () => configureI18n(manifest.i18n));

  if (providers !== undefined) await step('providers', steps, () => providers(manifest));
  if (ready !== undefined) await step('ready', steps, () => ready(manifest));
  if (root !== undefined) await step('root', steps, () => defineRoot(root));

  return { manifest, steps };
}

/**
 * The templates a first paint needs. That is the `entry` group when the manifest has
 * groups, and the whole flat list under source delivery. ADR-0081.
 *
 * @param {AppManifest} manifest
 * @returns {readonly string[]}
 */
function entryTemplates(manifest) {
  return manifest.templateGroups.entry ?? manifest.templateFiles;
}

/**
 * Run one step, record its duration and attach its name to any failure. The duration is
 * recorded in `finally`, so a failed step still reports how long it took.
 *
 * @template T
 * @param {StartupStep} name
 * @param {StartupStepRun[]} steps
 * @param {() => T | Promise<T>} body
 * @returns {Promise<T>}
 */
async function step(name, steps, body) {
  const run = { name, duration: 0 };
  steps.push(run);
  const started = performance.now();
  try {
    return await body();
  } catch (cause) {
    throw new ApplicationStartupError(name, cause);
  } finally {
    const ended = performance.now();
    run.duration = ended - started;
    performance.measure(`${STARTUP_MEASURE}${name}`, { start: started, end: ended });
  }
}

/**
 * Fetch the template bundle and seed the cache.
 *
 * A missing bundle isn't a startup failure. The page still works with one request per
 * template, and `npm run verify` reports a stale bundle.
 *
 * @param {string} url
 * @returns {Promise<void>}
 */
async function seedTemplateBundle(url) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (response.ok) seedTemplates(await readJson(response));
}

/**
 * Import the root module and check that it defined the root element.
 *
 * `@core/elements/mount.js` performs the check, as it does for every load-then-define
 * path. The page already contains the root element, so importing the module upgrades it.
 * The tag comes from the root class's definition. A spec that names no component throws,
 * because an element that never upgrades is a blank page.
 *
 * @param {ApplicationRoot} root
 * @returns {Promise<void>}
 */
async function defineRoot(root) {
  const tag = await defineTag({ where: 'the application root', tag: root.tag, load: root.load });
  if (tag === undefined) {
    throw new Error(
      'The root module named no component. Resolve `load` to the root class, with ' +
        '`.then((module) => module.AppRoot)`, or declare `root.tag`.',
    );
  }
}

/**
 * @param {unknown} cause
 * @returns {string}
 */
function describe(cause) {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  return JSON.stringify(cause) ?? 'an unknown error';
}
