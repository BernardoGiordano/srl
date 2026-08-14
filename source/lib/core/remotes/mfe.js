/**
 * Micro-frontend loading: the contract, not the adapter.
 *
 * A remote is a separately released static folder mounted behind the shell's
 * origin, containing one ESM entry module that exports `rootTag`, `mount(host)`
 * returning one root element per route mount, and the `contract` version it was
 * written against. That is the whole interface: the shell knows a remote's mount
 * path and root tag and nothing about its internal routes, state or components.
 *
 * A remote reaches the shell's services through `mount(host)` and nowhere else.
 * The host context is a capability object — an authorized `fetch`, a permission
 * query, navigation, translation — handed to one remote, bounded by that remote's
 * `grants`, and revoked when that exact root is unmounted. ADR-0016. This module
 * imports no auth, which is why it is in `core/` while the adapter that builds a
 * context lives in `host/`.
 *
 * Locations and artifact-owned styles, templates, and locales come from
 * app.manifest.json, fetched on every page load. Module digests are governed by
 * the page import map; stylesheet and template digests travel with their asset
 * records. Production composition projects a verified Remote artifact report into
 * both documents without putting the Remote implementation in the shell bundle.
 * Dependencies are shared because module identity is URL identity — one `lit`
 * URL, one instance — and a remote may use only its declared shared
 * bare-specifier interface. ADR-0017.
 */

import { inject, token } from '@core/foundation/inject.js';
import { requireElement } from '@core/elements/mount.js';
import { readJson } from '@core/foundation/json.js';
import { registerMessages } from '@core/localization/i18n.js';
import { admitManifest } from '@core/remotes/manifest-policy.js';
import { seedTemplates } from '@core/template/template.js';

/** @import { RouteDef } from '@core/navigation/types.js' */
/** @import { AppManifest, RemoteDescriptor, RemoteHostProvider, RemoteModule } from '@core/remotes/types.js' */

/**
 * Version of the host context. Bump it when a capability changes shape, and
 * every remote written against the old one fails to load with a message naming
 * both numbers instead of dying later inside a method that moved.
 */
export const HOST_CONTRACT = 2;

/**
 * Supplies mount guards and host contexts. Injected rather than imported so that
 * `core/` never depends on `auth/`: `startHostedApplication` in `@host/runtime.js`
 * installs `@host/remote-host.js` as the default, and an application with a
 * different capability policy provides its own instead from its `providers` hook.
 *
 * @type {import('@core/foundation/types.js').InjectionToken<RemoteHostProvider>}
 */
export const REMOTE_HOST = token('RemoteHostProvider');

/**
 * The manifest every reader sees, installed by `useManifest`.
 *
 * Module state rather than a global: a global is reachable from anywhere, so
 * nothing would force startup to be the only writer, and nothing would say which
 * module owns it.
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
 * Separate from `loadManifest` on purpose: fetching and validating is one thing,
 * deciding that this validated manifest is the application's is another, and the
 * second is a startup decision. `@core/application/runtime.js` is the caller that matters.
 * A test that needs a manifest whose remotes could never satisfy the page's
 * import-map pins is the other one.
 *
 * @param {AppManifest | undefined} value
 */
export function useManifest(value) {
  installed = value;
}

/**
 * Fetch app.manifest.json and admit it as this application's policy. Installs
 * nothing: pass the result to `useManifest`, or let `startApplication` do both in
 * order.
 *
 * `no-cache` rather than `no-store`: revalidate on every load so a redeployed
 * remote is picked up immediately, but still allow a 304 so the common case
 * costs no body transfer.
 *
 * Admission itself lives in `@core/remotes/manifest-policy.js`, which decides the
 * whole document at once and knows nothing about the page. This function is the
 * browser half of that seam: it fetches the document and says where the integrity
 * pins come from.
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
 * The integrity block of the page's static import map: the digests the browser
 * will actually enforce when a remote is imported.
 *
 * Read on demand rather than at load time, because it is only an answer to
 * "which bytes may execute", and an application with no remotes asks nobody.
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
 * `${mount}/*` matches the mount path and everything under it, so the remote owns
 * its whole subtree and the shell needs no knowledge of the remote's internal
 * paths. That is what lets a remote add or rename a sub-view without a shell
 * change.
 *
 * The route objects are created eagerly, which costs nothing: they are plain
 * objects with a closure. Only the remote's *code* is deferred, until the first
 * navigation into its mount path.
 *
 * The guard comes from the manifest's `requires` block, and the router runs it
 * before `load`. So a user without the entitlement never receives the remote's
 * code at all, which is a stronger statement than hiding its UI: for a remote
 * whose mere presence is confidential, the network tab is the leak.
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
        // Cache only the immutable module. Every invocation below creates a new
        // host connection and root element, which is the route mount boundary.
        pending ??= prepareRemote(remote);
        const module = await pending;
        const connection = host.connect(remote);

        try {
          // The element itself is built by `@core/elements/mount.js`, which validates that
          // the remote returned an element and that it is the `rootTag` the module
          // exported. What stays here is the part that is not about mounting at
          // all: one capability context per root, revoked the moment the mount
          // does not complete.
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

        // Authority ends at route exit, before optional remote cleanup runs.
        mounted.host.revoke();
        await mounted.module.unmount?.(element);
      },
    };
  });
}

/** @type {Map<string, Promise<void>>} */
const loadedAssets = new Map();

/**
 * Load descriptor-owned runtime assets before module evaluation. Guards still run first,
 * so a refused route downloads none of its independently published artifact.
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

/** @param {RemoteDescriptor} remote */
function seedRemoteTemplates(remote) {
  const url = remote.templates;
  if (url === undefined) return Promise.resolve();
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
  // A dynamic import of a specifier held in a variable is `any` to the type
  // checker, by necessity: the target is not known until runtime. This is the
  // exact point where static types stop being able to help, so the contract is
  // enforced by validation instead of assumed.
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
