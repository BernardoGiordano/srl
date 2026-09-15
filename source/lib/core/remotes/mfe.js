/**
 * Loads micro-frontends. This module holds the remote contract, and `host/` holds the
 * adapter that builds host contexts.
 *
 * A remote is a separately released static folder under the shell's origin. Its entry
 * module exports `rootTag`, a `mount(host)` that returns one root element per route
 * mount, and the `contract` version it targets. The shell knows only a remote's mount
 * path and root tag.
 *
 * A remote reaches the shell only through `mount(host)`. The host context is a
 * capability object bounded by the remote's `grants` and revoked when its root
 * unmounts. ADR-0016. This module imports no auth, which is why it lives in `core/`.
 *
 * Locations, styles, templates and locales come from the manifest. The import map pins
 * module digests, and asset records carry stylesheet and template digests. Shared
 * dependencies work because module identity is URL identity, and a remote may only use
 * the bare specifiers it declares as shared. ADR-0017.
 */

import { inject, token } from '@core/foundation/inject.js';
import { requireElement } from '@core/elements/mount.js';
import { readJson } from '@core/foundation/json.js';
import { registerMessages } from '@core/localization/i18n.js';
import { admitManifest } from '@core/remotes/manifest-policy.js';
import { prefetchTemplates, seedTemplates } from '@core/template/template.js';

/** @import { RouteDef } from '@core/navigation/types.js' */
/** @import { AppManifest, RemoteDescriptor, RemoteHostProvider, RemoteModule } from '@core/remotes/types.js' */

/**
 * Version of the host context. Bump it when a capability changes shape, so a remote
 * written against the old version fails to load with both numbers in the message.
 */
export const HOST_CONTRACT = 2;

/**
 * Supplies mount guards and host contexts. It is injected, so `core/` never imports
 * `auth/`. `startHostedApplication` in `@host/runtime.js` installs
 * `@host/remote-host.js` by default, and an application can provide its own from its
 * `providers` hook.
 *
 * @type {import('@core/foundation/types.js').InjectionToken<RemoteHostProvider>}
 */
export const REMOTE_HOST = token('RemoteHostProvider');

/**
 * The manifest every reader sees, set by `useManifest`. Module state, so only startup
 * writes it.
 *
 * @type {AppManifest | undefined}
 */
let installed;

/**
 * The active manifest.
 *
 * @returns {AppManifest}
 */
export function manifest() {
  if (installed === undefined) {
    throw new Error(
      'No manifest is installed. startApplication() in @core/application/runtime.js installs it before it ' +
        'imports the root component, so anything that reads the manifest must run after startup ' +
        'rather than during module evaluation.',
    );
  }
  return installed;
}

/**
 * Install the manifest, or clear it with `undefined`.
 *
 * Separate from `loadManifest`, because choosing the application's manifest is a
 * startup decision. Tests also install manifests whose remotes couldn't match the
 * page's pins.
 *
 * @param {AppManifest | undefined} value
 */
export function useManifest(value) {
  installed = value;
}

/**
 * Fetch `app.manifest.json` and admit it. This installs nothing, so pass the result to
 * `useManifest` or let `startApplication` do both.
 *
 * The fetch uses `no-cache`, so every load revalidates and picks up a redeployed
 * remote, while an unchanged manifest costs a 304.
 *
 * `@core/remotes/manifest-policy.js` does the admission. This function fetches the
 * document and supplies the page's pins.
 *
 * @param {string} [url]
 * @returns {Promise<AppManifest>}
 */
export async function loadManifest(url = '/app.manifest.json') {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`Cannot load ${url}: ${String(response.status)} ${response.statusText}`);
  }

  const value = /** @type {unknown} */ (await response.json());
  return admitManifest(value, { url, base: document.baseURI, pins: pagePins });
}

/**
 * The integrity block of the page's static import map, which the browser enforces when
 * a remote is imported. Read on demand, since an application without remotes never
 * needs it.
 *
 * @returns {Readonly<Record<string, unknown>>}
 */
function pagePins() {
  const script = document.querySelector('script[type="importmap"]');
  if (script === null) {
    throw new Error(
      'A remote cannot be verified: the page has no import map, so nothing pins the bytes the ' +
        'manifest names.',
    );
  }

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(script.textContent ?? '');
  } catch {
    throw new Error("A remote cannot be verified: the page's import map is invalid JSON.");
  }
  const map = asRecord(parsed, 'the page import map');
  return asRecord(map.integrity, 'the page import map integrity block');
}

/**
 * Build one lazily loaded route per remote.
 *
 * `${mount}/*` gives the remote its whole subtree, so it can add sub-views without a
 * shell change. Route objects are created up front, and only the remote's code waits
 * for the first navigation.
 *
 * The guard from the manifest's `requires` runs before `load`, so a user without the
 * entitlement never downloads the remote's code.
 *
 * @returns {RouteDef[]}
 */
export function remoteRoutes() {
  const host = inject(REMOTE_HOST);

  return manifest().remotes.map((remote) => {
    /** @type {Promise<RemoteModule> | undefined} */
    let pending;

    /** @type {WeakMap<HTMLElement, { module: RemoteModule, host: import('@core/remotes/types.js').RemoteHost }>} */
    const mounts = new WeakMap();

    return {
      path: `${remote.mount}/*`,
      canActivate: host.guard(remote),
      mount: async () => {
        // Cache only the module. Each mount gets a new host connection and root element.
        pending ??= prepareRemote(remote);
        const module = await pending;
        const connection = host.connect(remote);

        try {
          // `@core/elements/mount.js` builds and validates the element. This code owns
          // the capability context, which is revoked if the mount fails.
          const element = await requireElement({
            where: `Remote "${remote.name}"`,
            tag: module.rootTag,
            create: () => module.mount(connection.context),
          });

          mounts.set(element, { module, host: connection });
          return element;
        } catch (cause) {
          connection.revoke();
          throw cause;
        }
      },
      unmount: async (element) => {
        const mounted = mounts.get(element);
        if (mounted === undefined) return;
        mounts.delete(element);

        // Revoke authority before the remote's own cleanup runs.
        mounted.host.revoke();
        await mounted.module.unmount?.(element);
      },
    };
  });
}

/** @type {Map<string, Promise<void>>} */
const loadedAssets = new Map();

/**
 * Load a remote's styles, templates and locales before its module evaluates. Guards run
 * first, so a refused route downloads nothing.
 *
 * @param {RemoteDescriptor} remote
 */
async function prepareRemote(remote) {
  await Promise.all([
    ...(remote.assets ?? [])
      .filter((asset) => asset.type === 'style')
      .map((asset) => loadStyle(asset.url, asset.integrity)),
    seedRemoteTemplates(remote),
  ]);
  for (const pattern of remote.locales ?? []) await registerMessages(pattern);
  return importRemote(remote);
}

/**
 * @param {string} url
 * @param {string} integrity
 */
function loadStyle(url, integrity) {
  let pending = loadedAssets.get(url);
  if (pending !== undefined) return pending;
  pending = new Promise((done, fail) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = url;
    link.integrity = integrity;
    link.crossOrigin = 'anonymous';
    link.addEventListener('load', () => done(undefined), { once: true });
    link.addEventListener('error', () => fail(new Error(`Cannot load remote stylesheet ${url}.`)), {
      once: true,
    });
    document.head.append(link);
  });
  loadedAssets.set(url, pending);
  return pending;
}

/**
 * Start a remote's markup beside its entry module. ADR-0081.
 *
 * A template bundle is fetched, seeded and awaited, because the remote's components
 * read the cache as soon as its module evaluates. Split templates are separate files,
 * so their URLs are started now and nothing waits.
 *
 * @param {RemoteDescriptor} remote
 */
function seedRemoteTemplates(remote) {
  const url = remote.templates;
  if (url === undefined) {
    prefetchTemplates(remote.templateFiles);
    return Promise.resolve();
  }
  let pending = loadedAssets.get(url);
  if (pending !== undefined) return pending;
  const integrity = remote.assets?.find((asset) => asset.type === 'template' && asset.url === url)
    ?.integrity;
  pending = fetch(url, { cache: 'force-cache', integrity })
    .then(async (response) => {
      if (response.ok) seedTemplates(await readJson(response));
    })
    .then(() => undefined);
  loadedAssets.set(url, pending);
  return pending;
}

/**
 * @param {RemoteDescriptor} remote
 * @returns {Promise<RemoteModule>}
 */
async function importRemote(remote) {
  // Importing a URL held in a variable is `any` to the type checker, so the contract is
  // validated below.
  const module = /** @type {unknown} */ (await import(remote.url));
  return assertRemoteModule(module, remote);
}

/**
 * @param {unknown} value
 * @param {RemoteDescriptor} remote
 * @returns {RemoteModule}
 */
function assertRemoteModule(value, remote) {
  const where = `Remote "${remote.name}" (${remote.url})`;
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${where} did not evaluate to a module.`);
  }

  const candidate = /** @type {Partial<RemoteModule>} */ (value);
  if (typeof candidate.rootTag !== 'string' || !candidate.rootTag.includes('-')) {
    throw new Error(
      `${where} must export \`rootTag\` as a valid custom element name ` +
        `(a string containing a hyphen). Got ${JSON.stringify(candidate.rootTag)}.`,
    );
  }
  if (typeof candidate.mount !== 'function') {
    throw new Error(`${where} must export a mount(host) function.`);
  }
  if (candidate.unmount !== undefined && typeof candidate.unmount !== 'function') {
    throw new Error(`${where} exports \`unmount\` but it is not a function.`);
  }
  if (candidate.contract !== HOST_CONTRACT) {
    throw new Error(
      `${where} must export \`contract\` equal to ${String(HOST_CONTRACT)}, the host contract ` +
        `this shell provides. Got ${JSON.stringify(candidate.contract)}. Update the remote, or ` +
        `deploy it against a shell of its own version.`,
    );
  }

  return /** @type {RemoteModule} */ (candidate);
}

/**
 * @param {unknown} value
 * @param {string} where
 * @returns {Record<string, unknown>}
 */
function asRecord(value, where) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where} is not an object.`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}
