/**
 * Application startup.
 *
 * Booting is a transaction: fetch the manifest, seed the template cache from it,
 * load the starting locale, install providers, settle the session, then define the
 * root element. Every step depends on the one before it, and getting the order
 * wrong does not throw — it flashes untranslated text, or bounces a deep link to
 * the login page because a guard read a session that had not been restored yet.
 *
 * So the order lives here once and an application supplies the parts that are
 * genuinely its own as hooks. A step is ordering the library owns; a hook is a
 * decision only the application can make, and the runtime never guesses at one.
 * Hooks receive the validated manifest, so an application reads its runtime
 * configuration from the argument rather than from a global.
 *
 * Every step is wrapped, and a failure inside one is rethrown as an
 * `ApplicationStartupError` naming the step, with the original error as `cause`:
 * a blank page is the worst thing this codebase can produce, and the console
 * message that comes with it usually points at whatever ran last rather than at
 * the step that failed.
 */

import { configureI18n } from '@core/localization/i18n.js';
import { loadManifest, useManifest } from '@core/remotes/mfe.js';
import { defineTag } from '@core/elements/mount.js';
import { readJson } from '@core/foundation/json.js';
import { prefetchTemplates, seedTemplates } from '@core/template/template.js';

/** @import { ApplicationRoot, ApplicationSpec, StartedApplication, StartupStep } from '@core/application/types.js' */

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
 * Steps run in this order, and each is skipped when the application does not use
 * it:
 *
 *   1. `configure`   Synchronous application setup that must precede everything,
 *                    typically `configureTheme()`. Runs before the manifest so a
 *                    theme is in place before the first byte of it arrives.
 *   2. `manifest`    Fetch and validate `app.manifest.json`, then install it.
 *                    Remote locations, the API base URL and the locale
 *                    configuration all come from it, so nothing that depends on
 *                    any of them can be constructed before it lands.
 *   3. `templates`   Warm the template cache from whichever list the manifest
 *                    carries: seed it outright from `templateBundle`, or start
 *                    every URL in `templateFiles` arriving. Here because a
 *                    component fetches its own template while loading, and by the
 *                    time it does the URL has to be known already — a chunk of
 *                    nine components otherwise costs nine requests in a row.
 *   4. `locale`      `configureI18n`, awaited. A component that renders once
 *                    against an empty message table and again against a full one
 *                    flashes untranslated text; ordering it away costs one await.
 *   5. `providers`   The application installs its injection providers. After the
 *                    manifest because most of them are configured from it.
 *   6. `ready`       Whatever the application needs settled before the first
 *                    route resolves — a session restore, which is what stops a
 *                    refresh on a deep link from bouncing the user to the login
 *                    page.
 *   7. `root`        Import the module that defines the root element, and verify
 *                    that it did. Last, because it is the point at which
 *                    components start rendering.
 *
 * The root module is imported dynamically rather than named in a static import,
 * because a static import is evaluated before any of the above runs.
 *
 * @param {ApplicationSpec} spec
 * @returns {Promise<StartedApplication>}
 */
export async function startApplication(spec) {
  /** @type {StartupStep[]} */
  const steps = [];

  const { configure, providers, ready, root } = spec;

  if (configure !== undefined) await step('configure', steps, configure);

  const manifest = await step('manifest', steps, async () => {
    const value = spec.manifest ?? (await loadManifest(spec.manifestUrl));
    useManifest(value);
    return value;
  });

  // Seeding wins when both are present: it puts the markup in the cache from bytes
  // already in hand, which makes the prefetch it would otherwise start a set of
  // requests for templates nothing will ever read from the network.
  const bundle = manifest.templateBundle;
  if (bundle !== undefined) {
    await step('templates', steps, () => seedTemplateBundle(bundle));
  } else if (manifest.templateFiles.length > 0) {
    await step('templates', steps, () => prefetchTemplates(manifest.templateFiles));
  }

  await step('locale', steps, () => configureI18n(manifest.i18n));

  if (providers !== undefined) await step('providers', steps, () => providers(manifest));
  if (ready !== undefined) await step('ready', steps, () => ready(manifest));
  if (root !== undefined) await step('root', steps, () => defineRoot(root));

  return { manifest, steps };
}

/**
 * Run one step, recording that it ran and attaching its name to any failure.
 *
 * @template T
 * @param {StartupStep} name
 * @param {StartupStep[]} steps
 * @param {() => T | Promise<T>} body
 * @returns {Promise<T>}
 */
async function step(name, steps, body) {
  steps.push(name);
  try {
    return await body();
  } catch (cause) {
    throw new ApplicationStartupError(name, cause);
  }
}

/**
 * Fetch the pre-bundled template map and seed the cache with it.
 *
 * A bundle that is configured but missing is not a startup failure: the compile
 * path is identical either way, so the page still works at the cost of one
 * request per template, which is the correct behaviour for an optimisation.
 * `npm run verify` is what reports a bundle that is configured and stale.
 *
 * @param {string} url
 * @returns {Promise<void>}
 */
async function seedTemplateBundle(url) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (response.ok) seedTemplates(await readJson(response));
}

/**
 * Import the root module and check that it defined the element the page holds.
 *
 * `@core/elements/mount.js` owns that check, because every other load-then-define
 * path in the library goes through it. The root element is the one that is not
 * instantiated here — the page already contains it, and importing its module is
 * what makes the browser upgrade it — but the rule is the same one.
 *
 * The tag comes from the root component's own definition, because `load` resolves
 * the class. A spec that resolves nothing nameable and declares no `tag` is a
 * misconfiguration rather than a silent skip: that combination leaves a page whose
 * root element is never upgraded, which is the blank page this step exists to
 * catch. Nothing is loaded when the tag is already defined.
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
