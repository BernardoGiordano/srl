/**
 * Adopts the stylesheets Elements own. Source delivery only.
 *
 * A styled Element's sibling `.css` is fetched, scoped by
 * `@core/elements/style-scope.js` and adopted before its tag is defined, so the first
 * render is styled. A production build puts the scoped rules in the application
 * stylesheet and marks the Element `styles: 'bundled'` instead. ADR-0119.
 *
 * Adopted sheets come after every stylesheet in the document. A `<style>` inserted
 * first would declare the `components` layer before Tailwind declares its order,
 * and sort it under preflight.
 */

import { scopeStylesheet } from '@core/elements/style-scope.js';

/**
 * The tag and adopted sheet for each stylesheet URL. The promise is cached, so a
 * revision that arrives mid-request applies after the request finishes.
 *
 * @type {Map<string, { tag: string, sheet: Promise<CSSStyleSheet> }>}
 */
const byUrl = new Map();

/**
 * Fetch, scope and adopt the stylesheet an Element owns. `defineComponent` awaits
 * this before `customElements.define`.
 *
 * @internal
 * @param {string} tag
 * @param {string | URL} url
 * @returns {Promise<void>}
 */
export async function attachStylesheet(tag, url) {
  const href = new URL(url, document.baseURI).href;
  let entry = byUrl.get(href);
  if (entry === undefined) {
    entry = { tag, sheet: adopt(tag, href) };
    byUrl.set(href, entry);
  } else if (entry.tag !== tag) {
    throw new Error(
      `${href} is already the stylesheet of <${entry.tag}>, so <${tag}> cannot own it too. ` +
        'A stylesheet is scoped to one tag; two Elements declared in one module need a ' +
        'module each to have a stylesheet each.',
    );
  }
  await entry.sheet;
}

/**
 * Replace the rules of an adopted stylesheet in place. Development only.
 *
 * The sheet keeps its position and hosts keep their state. A stylesheet that can't
 * be scoped throws before anything changes.
 *
 * @internal
 * @param {string | URL} url
 * @param {string} source
 * @returns {Promise<boolean>} Whether an Element on this page owns the URL.
 */
export async function reviseStylesheet(url, source) {
  const href = new URL(url, document.baseURI).href;
  const entry = byUrl.get(href);
  if (entry === undefined) return false;

  const scoped = scopeStylesheet(entry.tag, source, href);
  (await entry.sheet).replaceSync(scoped);
  return true;
}

/**
 * @param {string} tag
 * @param {string} href
 * @returns {Promise<CSSStyleSheet>}
 */
async function adopt(tag, href) {
  const response = await fetch(href);
  if (!response.ok) {
    throw new Error(
      `Cannot load stylesheet ${href}: ${String(response.status)} ${response.statusText}`,
    );
  }
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(scopeStylesheet(tag, await response.text(), href));
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  return sheet;
}
