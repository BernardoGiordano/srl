import { inject, provide, resetInjector } from '@core/foundation/inject.js';
import { REMOTE_HOST, remoteRoutes, useManifest } from '@core/remotes/mfe.js';
import { startHostedApplication } from '@host/runtime.js';
import { assert, present } from '../harness.js';

/** @import { AppManifest, RemoteDescriptor, RemoteHostProvider } from '@core/remotes/types.js' */

/**
 * Startup for an application that mounts micro-frontends.
 *
 * What is worth asserting here is not that a wrapper calls a function. It is that
 * an application which declares no providers at all can still mount a remote —
 * previously the one thing every such application had to wire by hand, and the one
 * whose omission booted cleanly and failed on the first navigation into a remote.
 */

/**
 * @param {Partial<RemoteDescriptor>} [overrides]
 * @returns {AppManifest}
 */
function manifestWith(overrides) {
  // Installed as a literal rather than fetched: a manifest that goes through
  // `loadManifest` has to name a remote whose digest is pinned in the test page's
  // import map, and nothing here loads a remote's code.
  return /** @type {AppManifest} */ ({
    remotes: [
      {
        name: 'analytics',
        url: '/remotes/analytics/remote-entry.js',
        integrity: 'sha384-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        mount: '/analytics',
        requires: { session: true, permissions: ['analytics:read'] },
        grants: { api: ['/api/analytics/'], permissions: ['analytics:read'] },
        templateFiles: [],
        ...overrides,
      },
    ],
    auth: { apiBaseUrl: '/api/' },
    i18n: { defaultLocale: 'en', supportedLocales: ['en'], bundles: [] },
    templateGroups: {},
    templateFiles: [],
  });
}

describe('hosted application startup', () => {
  beforeEach(() => {
    resetInjector();
  });

  afterEach(() => {
    useManifest(undefined);
    resetInjector();
  });

  it('installs the remote host adapter for an application that declares no providers', async () => {
    const started = await startHostedApplication({ manifest: manifestWith() });

    // The step ran even though the application supplied no hook: mounting remotes
    // is a provider installation, and this is the application saying it does.
    assert.sameArray(
      started.steps.map((run) => run.name),
      ['manifest', 'locale', 'providers'],
    );

    // Through the interface `@core/remotes/mfe.js` uses, which is the only caller that
    // matters: a route per remote, with the manifest's `requires` block turned
    // into a guard the router runs before the remote's code is fetched.
    const route = present(remoteRoutes()[0]);
    assert.equal(route.path, '/analytics/*');
    assert.ok(route.canActivate !== undefined, 'a remote with requirements must be guarded');

    // The real adapter rather than a stand-in: it reports the contract version and
    // the mount path the manifest gave this remote.
    const { context } = inject(REMOTE_HOST).connect(present(manifestWith().remotes[0]));
    assert.equal(context.contract, 2);
    assert.equal(context.mount, '/analytics');
    assert.equal(context.name, 'analytics');
  });

  it('builds no guard for a public remote', async () => {
    await startHostedApplication({
      manifest: manifestWith({ requires: { session: false, permissions: [] } }),
    });

    assert.equal(
      present(remoteRoutes()[0]).canActivate,
      undefined,
      'an unguarded remote route must not pay for an await',
    );
  });

  it('lets an application with its own capability policy replace the default', async () => {
    /** @type {RemoteHostProvider} */
    const policy = {
      guard: () => undefined,
      connect: () => {
        throw new Error('not exercised');
      },
    };

    /** @type {string[]} */
    const seen = [];

    await startHostedApplication({
      manifest: manifestWith(),
      // Runs after the default is installed, and `provide` replaces, so this wins.
      // An application whose remotes get a different set of capabilities is the
      // reason `@core/remotes/mfe.js` injects the provider instead of importing one.
      providers: (received) => {
        seen.push(received.auth.apiBaseUrl);
        provide(REMOTE_HOST, () => policy);
      },
    });

    assert.equal(inject(REMOTE_HOST), policy);
    assert.sameArray(seen, ['/api/'], "the application's own hook still receives the manifest");
  });
});
