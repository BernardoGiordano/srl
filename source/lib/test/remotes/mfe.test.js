import { provide, resetInjector } from '@core/foundation/inject.js';
import { REMOTE_HOST, loadManifest, remoteRoutes, useManifest } from '@core/remotes/mfe.js';
import { assert, present } from '../harness.js';

/** @import { AppManifest, HostContext, RemoteHostProvider } from '@core/remotes/types.js' */

describe('remote mount lifecycle', () => {
  beforeEach(() => {
    resetInjector();
  });

  afterEach(() => {
    useManifest(undefined);
    resetInjector();
  });

  it('creates and revokes one capability context per mount while caching the module', async () => {
    /** @type {Array<{ context: HostContext, revoked: boolean }>} */
    const connections = [];
    let nextId = 0;

    /** @type {RemoteHostProvider} */
    const provider = {
      guard: () => undefined,
      connect: (remote) => {
        const id = ++nextId;
        let revoked = false;
        const alive = () => {
          if (revoked) throw new Error(`context ${String(id)} revoked`);
          return remote.mount;
        };
        const context = /** @type {HostContext} */ ({
          contract: 2,
          name: remote.name,
          mount: remote.mount,
          auth: {},
          i18n: {},
          router: { path: alive },
        });
        const record = { context, revoked: false };
        connections.push(record);
        return {
          context,
          revoke: () => {
            revoked = true;
            record.revoked = true;
          },
        };
      },
    };
    provide(REMOTE_HOST, () => provider);

    // Installed directly rather than through loadManifest(): the fixture remote's
    // digest is deliberately not in the test page's import map, which the manifest
    // validator would refuse — and rightly, since that pin is what governs which
    // bytes may execute.
    useManifest(/** @type {AppManifest} */ ({
      remotes: [
        {
          name: 'lifecycle',
          url: new URL('../fixtures/lifecycle-remote.js', import.meta.url).href,
          integrity: 'sha384-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          assets: [],
          shared: [],
          locales: [],
          mount: '/lifecycle',
          requires: { session: false, permissions: [] },
          grants: { api: [], permissions: [] },
        },
      ],
      auth: { apiBaseUrl: '/api/' },
      i18n: { defaultLocale: 'en', supportedLocales: ['en'], bundles: [] },
    }));

    const route = present(remoteRoutes()[0]);
    const first = await present(route.mount)();
    assert.equal(connections.length, 1);
    assert.equal(
      /** @type {HTMLElement & { host?: HostContext }} */ (first).host,
      connections[0]?.context,
    );

    await route.unmount?.(first);
    assert.ok(connections[0]?.revoked);
    assert.throws(() => connections[0]?.context.router.path(), 'context 1 revoked');

    const second = await present(route.mount)();
    assert.equal(connections.length, 2, 'the cached ESM must still receive a fresh connection');
    assert.notOk(first === second);
    assert.notOk(connections[1]?.revoked);
    await route.unmount?.(second);
    assert.ok(connections[1]?.revoked);
  });

  it('rejects cross-origin remote code before it can be imported', async () => {
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(
        Response.json(
          manifestWithRemote({
            url: 'https://remote.example/entry.js',
            integrity: 'sha384-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          }),
        ),
      );
    try {
      await assert.rejects(() => loadManifest('/cross-origin.json'), 'must be same-origin');
    } finally {
      globalThis.fetch = nativeFetch;
    }
  });

  it('rejects a manifest digest that is not governed by the static import map', async () => {
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(
        Response.json(
          manifestWithRemote({
            url: '/not-pinned/entry.js',
            integrity: 'sha384-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          }),
        ),
      );
    try {
      await assert.rejects(() => loadManifest('/unpinned.json'), 'does not match');
    } finally {
      globalThis.fetch = nativeFetch;
    }
  });
});

/**
 * @param {{ url: string, integrity: string }} remote
 * @returns {AppManifest}
 */
function manifestWithRemote(remote) {
  return {
    remotes: [
      {
        name: 'fixture',
        mount: '/fixture',
        requires: { session: false, permissions: [] },
        grants: { api: [], permissions: [] },
        assets: [],
        shared: [],
        locales: [],
        ...remote,
      },
    ],
    auth: { apiBaseUrl: '/api/' },
    i18n: { defaultLocale: 'en', supportedLocales: ['en'], bundles: [] },
  };
}
