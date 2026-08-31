import { manifest, useManifest } from '@core/remotes/mfe.js';
import { ApplicationStartupError, startApplication } from '@core/application/runtime.js';
import { loadTemplate } from '@core/template/template.js';
import { assert, present } from '../harness.js';

/** @import { AppManifest } from '@core/remotes/types.js' */

/**
 * Startup, tested through the interface an application calls.
 *
 * This is the test that could not be written while the boot sequence lived in
 * each application's main.js: verifying the order meant booting an application in a
 * browser and asserting on rendered output, so a reordering bug surfaced as a
 * failing smoke test somewhere else. Here the order, the skipped steps and the
 * failure messages are all assertions of the library's own.
 */

const MANIFEST = new URL('../fixtures/startup-manifest.json', import.meta.url).href;
const BUNDLED = new URL('../fixtures/startup-bundled-manifest.json', import.meta.url).href;
const MISSING_BUNDLE = new URL('../fixtures/startup-missing-bundle-manifest.json', import.meta.url)
  .href;
const SPLIT = new URL('../fixtures/startup-split-manifest.json', import.meta.url).href;

/**
 * The names of the steps that ran. Each entry carries its duration too, so the
 * order — which is what most of these cases are about — reads through here rather
 * than through an assertion on objects whose timings are never the same twice.
 *
 * @param {import('@core/application/types.js').StartedApplication} started
 * @returns {string[]}
 */
const names = (started) => started.steps.map((run) => run.name);

describe('application startup', () => {
  afterEach(() => {
    useManifest(undefined);
  });

  it('runs only the steps the application declares', async () => {
    const started = await startApplication({ manifestUrl: MANIFEST });

    // No theme, no providers, no session: a minimal application's shape. The skipped steps are absent rather than run with a default, which
    // is what keeps an optional feature optional.
    assert.sameArray(names(started), ['manifest', 'locale']);
    assert.equal(started.manifest.auth.apiBaseUrl, '/api/');
    assert.equal(manifest(), started.manifest, 'startup must install what it validated');
  });

  it('orders every step and awaits each one before the next', async () => {
    /** @type {string[]} */
    const order = [];

    const started = await startApplication({
      manifestUrl: MANIFEST,
      configure: () => {
        order.push('configure');
      },
      // Each hook receives the validated manifest, so an application reads its
      // runtime configuration from the argument rather than from a global.
      //
      // Deliberately slow. A runtime that fired the hooks without awaiting them
      // would record this one after `ready`, which is exactly the class of bug
      // that used to be invisible until a guard raced a session restore.
      providers: async (received) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push(`providers:${received.auth.apiBaseUrl}`);
      },
      ready: () => {
        order.push('ready');
      },
      root: {
        tag: 'startup-fixture-root',
        load: async () => {
          order.push('root');
          await import('../fixtures/startup-root.js');
        },
      },
    });

    assert.sameArray(order, ['configure', 'providers:/api/', 'ready', 'root']);
    assert.sameArray(names(started), [
      'configure',
      'manifest',
      'locale',
      'providers',
      'ready',
      'root',
    ]);
    assert.ok(customElements.get('startup-fixture-root'), 'the root element must be defined');
  });

  it('reports what each step cost, on the result and as a User Timing measure', async () => {
    const started = await startApplication({
      manifestUrl: MANIFEST,
      // Deliberately slow, and the only slow step: a per-step duration that came from
      // a shared stopwatch would spread this wait across the steps around it.
      providers: () => new Promise((resolve) => setTimeout(resolve, 20)),
    });

    const providers = present(
      started.steps.find((run) => run.name === 'providers'),
      'the providers step must be reported',
    );
    assert.ok(
      providers.duration >= 15,
      `the slow step must carry its own duration, got ${String(providers.duration)} ms`,
    );

    const locale = present(started.steps.find((run) => run.name === 'locale'));
    assert.ok(locale.duration < providers.duration, 'each step is timed on its own');

    // The measure is what a profiler and the benchmark harness read: neither of them
    // holds this return value, and the harness only looks at the page long after
    // startup resolved.
    const measure = present(
      performance.getEntriesByName('srl:startup:providers', 'measure').at(-1),
      'the step must emit a srl:startup: measure',
    );
    assert.ok(
      Math.abs(measure.duration - providers.duration) < 1,
      'the measure and the reported duration must be the same fact',
    );
  });

  it('measures a step that failed, up to the point it failed', async () => {
    await assert.rejects(
      () =>
        startApplication({
          manifestUrl: MANIFEST,
          ready: async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            throw new Error('session endpoint unreachable');
          },
        }),
      'Application startup failed at step "ready"',
    );

    // A boot that fails slowly is the case where the timing matters most, and it is
    // the one a stopwatch stopped after the body would lose.
    const measure = present(
      performance.getEntriesByName('srl:startup:ready', 'measure').at(-1),
      'a failed step must still be measured',
    );
    assert.ok(
      measure.duration >= 15,
      `expected the failure to carry its wait, got ${String(measure.duration)} ms`,
    );
  });

  it('accepts an already-validated manifest instead of fetching one', async () => {
    const embedded = /** @type {AppManifest} */ ({
      remotes: [],
      auth: { apiBaseUrl: '/api/' },
      i18n: { defaultLocale: 'en', supportedLocales: ['en'], bundles: [] },
      templateFiles: [],
    });

    const started = await startApplication({ manifest: embedded });
    assert.equal(started.manifest, embedded);
    assert.equal(manifest(), embedded);
  });

  it('names the failing step and keeps the original error as its cause', async () => {
    const cause = new Error('token endpoint unreachable');

    /** @type {unknown} */
    let caught;
    try {
      await startApplication({ manifestUrl: MANIFEST, ready: () => Promise.reject(cause) });
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof ApplicationStartupError, 'the failure must name the step');
    const failure = /** @type {ApplicationStartupError} */ (caught);
    assert.equal(failure.step, 'ready');
    assert.equal(failure.cause, cause, 'the original error must survive');
    assert.includes(
      failure.message,
      'Application startup failed at step "ready": token endpoint unreachable',
    );
  });

  it('reports a manifest that cannot be fetched as the manifest step', async () => {
    await assert.rejects(
      () => startApplication({ manifestUrl: '/lib/test/fixtures/startup-no-such-manifest.json' }),
      'Application startup failed at step "manifest"',
    );
  });

  it('refuses a root module that defines no element', async () => {
    // The message is `@core/elements/mount.js`'s, which is the point: the root element is
    // checked by the same rule as an outlet target, a route level and a remote
    // root, so all four report a module that defined nothing the same way.
    await assert.rejects(
      () =>
        startApplication({
          manifestUrl: MANIFEST,
          root: {
            tag: 'startup-undefined-root',
            load: () => import('../fixtures/startup-silent-root.js'),
          },
        }),
      'the application root names <startup-undefined-root>, still undefined after `load` resolved',
    );
  });

  it('seeds the template cache from the manifest bundle', async () => {
    const started = await startApplication({ manifestUrl: BUNDLED });
    assert.sameArray(names(started), ['manifest', 'templates', 'locale']);

    // No such file exists. Resolving it proves the source came from the bundle,
    // and that the seed happened before anything could ask for a template.
    const template = await loadTemplate('/lib/test/fixtures/startup-seeded.html');
    assert.equal(typeof template, 'function');
  });

  it('starts anyway when the configured template bundle is missing', async () => {
    const started = await startApplication({ manifestUrl: MISSING_BUNDLE });

    // A bundle is an optimisation: absent, every template costs its own request
    // and the page still works. Failing startup over it would trade a slower boot
    // for no boot.
    assert.sameArray(names(started), ['manifest', 'templates', 'locale']);
  });

  it('starts every template the manifest names without waiting for any of them', async () => {
    const url = '/lib/test/fixtures/route-layout.html';
    let resolveFetch = () => {};
    const blocked = new Promise((resolve) => {
      resolveFetch = () => {
        resolve(undefined);
      };
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = /** @type {typeof globalThis.fetch} */ (
      async (/** @type {RequestInfo | URL} */ input, /** @type {RequestInit} */ init) => {
        const href =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (href.endsWith(url)) {
          // Held open for the whole of startup. A step that awaited the prefetch
          // would never reach `locale`, which is the property under test: the
          // ordering matters, the completion does not.
          await blocked;
        }
        return realFetch(input, init);
      }
    );
    try {
      const started = await startApplication({ manifestUrl: SPLIT });
      assert.sameArray(names(started), ['manifest', 'templates', 'locale']);
      assert.sameArray([...started.manifest.templateFiles], [url]);

      resolveFetch();
      // The request was in flight before this line, so the component that asks for
      // it later shares that one rather than starting a second. ADR-0081.
      assert.equal(typeof (await loadTemplate(url)), 'function');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
