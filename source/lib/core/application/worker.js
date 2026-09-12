/**
 * Registering the service worker the build generated.
 *
 * The worker itself is not here and cannot be: it is a projection of one artifact's
 * file list, written by `@srljs/cli`'s `service-worker.mjs` from the report that
 * artifact carries. What the library owns is the other side of that seam — the one
 * call that installs it, and the four conditions under which not installing it is
 * the right answer.
 *
 * It is a call rather than a startup step for the same reason `configureTheme` is a
 * hook: an application that is not deployed as an artifact has no `/sw.js` to
 * register, a development origin deliberately has none, and a library that
 * registered one anyway would be caching a dev server's bytes behind a policy it
 * invented. So the ordering the runtime owns stays seven steps, and this is a
 * decision an application makes.
 *
 * WHEN TO CALL IT
 *
 * After startup, not during. Registration costs a request and an install, and both
 * belong after the first view is on screen rather than in front of it — the whole
 * value of the generated worker is on the *second* load. `startApplication` resolving
 * is the natural moment.
 *
 * ADR-0088.
 */

/**
 * @typedef {{ createScriptURL(value: string): unknown }} WorkerPolicy
 * @typedef {{ createPolicy(name: string, rules: { createScriptURL(value: string): string }): WorkerPolicy }} WorkerPolicyFactory
 */

/** @type {WorkerPolicy | null | undefined} */
let policy;

/**
 * The registration URL as a value Trusted Types will accept.
 *
 * `register()` is a script-URL sink, and every artifact this toolchain builds ships
 * `require-trusted-types-for 'script'` — so a bare string throws under the CSP the
 * build writes, and the worker silently never installs. The policy is named
 * `srl-worker` there, it is created on the first registration rather than at import
 * (a page that never registers asks a CSP for nothing), and it accepts same-origin
 * URLs only, which is all a service worker script can be.
 *
 * @param {string} url
 * @returns {unknown} the URL, trusted where the page requires it
 */
function scriptUrl(url) {
  const factory = /** @type {{ trustedTypes?: WorkerPolicyFactory }} */ (
    /** @type {unknown} */ (globalThis)
  ).trustedTypes;
  if (factory === undefined) return url;
  policy ??= factory.createPolicy('srl-worker', {
    createScriptURL: (value) => {
      const resolved = new URL(value, location.href);
      if (resolved.origin !== location.origin) {
        throw new Error(`registerServiceWorker: ${value} is not on this origin.`);
      }
      return resolved.href;
    },
  });
  return policy.createScriptURL(url);
}

/**
 * @typedef {object} ServiceWorkerOptions
 * @property {string} [url] Where the worker is served from. `/sw.js` is what the build emits and what its scope requires.
 * @property {boolean} [when] Register only when this is true. An application gates on its own condition — a manifest flag, an origin, a user setting — rather than this module guessing at one.
 */

/**
 * Install the generated worker, or say why it was not installed.
 *
 * Resolves rather than rejects on every failure it can name. A service worker is an
 * optimisation over an application that already works without one: a browser that
 * does not support it, a page served over plain HTTP, an origin with no `/sw.js` and
 * a registration the user's settings refuse are all "no worker today", and none of
 * them is a reason to fail a boot that has otherwise succeeded.
 *
 * @param {ServiceWorkerOptions} [options]
 * @returns {Promise<ServiceWorkerRegistration | null>} the registration, or null when there is none
 */
export async function registerServiceWorker(options = {}) {
  const { url = '/sw.js', when = true } = options;
  if (!when) return null;
  // Secure context rather than a protocol test: `localhost` is one, and it is where
  // an artifact is verified in a browser before it is deployed anywhere.
  if (!isSecureContext || !('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register(/** @type {string} */ (scriptUrl(url)));
  } catch {
    return null;
  }
}
