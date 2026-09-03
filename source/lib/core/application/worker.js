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
    return await navigator.serviceWorker.register(url);
  } catch {
    return null;
  }
}
