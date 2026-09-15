/**
 * Registers the service worker the build generated. ADR-0088.
 *
 * `@srljs/cli`'s `service-worker.mjs` writes the worker from the artifact report. This
 * module owns only the registration call.
 *
 * Registration is an application call instead of a startup step, because applications
 * not deployed as artifacts, and development origins, have no `/sw.js`.
 *
 * Call it after `startApplication` resolves. The worker helps the second load, so its
 * request and install shouldn't delay the first view.
 */

/**
 * @typedef {{ createScriptURL(value: string): unknown }} WorkerPolicy
 * @typedef {{ createPolicy(name: string, rules: { createScriptURL(value: string): string }): WorkerPolicy }} WorkerPolicyFactory
 */

/** @type {WorkerPolicy | null | undefined} */
let policy;

/**
 * The registration URL as a Trusted Types script URL.
 *
 * `register()` is a script-URL sink, and every built artifact ships
 * `require-trusted-types-for 'script'`, so a plain string would throw. The build's CSP
 * names the `srl-worker` policy. It is created on first registration and accepts only
 * same-origin URLs.
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
 * @property {boolean} [when] Register only when true. The application decides the condition, such as a manifest flag, an origin or a user setting.
 */

/**
 * Install the generated worker, or resolve null when it can't be installed.
 *
 * It never rejects. A worker is an optimization, so a missing API, an insecure page, a
 * missing `/sw.js` or a refused registration all just mean no worker today.
 *
 * @param {ServiceWorkerOptions} [options]
 * @returns {Promise<ServiceWorkerRegistration | null>} the registration, or null when there is none
 */
export async function registerServiceWorker(options = {}) {
  const { url = '/sw.js', when = true } = options;
  if (!when) return null;
  // `isSecureContext` includes `localhost`, where artifacts are checked before deploy.
  if (!isSecureContext || !('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register(/** @type {string} */ (scriptUrl(url)));
  } catch {
    return null;
  }
}
