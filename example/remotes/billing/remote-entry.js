import { tagOf } from '@core/elements/component.js';
import { BillingRoot } from './billing-root.js';

/**
 * The same-stack micro-frontend.
 *
 * This remote imports `lit`, `@core/foundation/reactive.js`, `@core/elements/component.js`
 * and two elements from `@components/` — all by the bare specifiers the shell's
 * `index.html` declares, so there is exactly one Lit instance, one signal graph and one
 * copy of the component collection on the page. Module Federation's shared-singleton
 * guarantee, for free, because module identity in ESM is URL identity.
 *
 * What it does *not* import is the shell: no route table, no services, no application
 * state. Its mount path, its routing and its translations all arrive through the
 * capability context, which is the same seam `remotes/analytics/` uses — and that remote
 * shares no dependency with the shell at all. Compare the two import lists; the contrast
 * is the point of shipping both.
 *
 * To deploy this independently: publish the folder to a versioned path on the shell's
 * origin, then update `remotes[].url`, its digest in `app.manifest.json` and the pins in
 * `index.html`. The shell picks it up on the next page load, templates and translations
 * included, because both resolve against `import.meta.url`.
 */

/** The host contract version this remote was written against. Required because `mount` is exported. */
export const contract = 2;

/**
 * Read from the component's own definition, so the tag exists once — in
 * `billing-root.js` — rather than here as well.
 */
export const rootTag = tagOf(BillingRoot);

/**
 * @param {import('@core/remotes/types.js').HostContext} host
 * @returns {HTMLElement}
 */
export function mount(host) {
  // Bound before the element is returned, so it is connected — and rendering — with this
  // mount's context and never without one. One context per root, which is what makes
  // `revoke()` on route exit mean something.
  const element = /** @type {BillingRoot} */ (document.createElement(rootTag));
  element.useHost(host);
  return element;
}
