/**
 * The stylesheets Elements own, adopted by the page that defines them.
 *
 * Source delivery only. A styled Element's `.css` sibling is fetched, scoped to its tag
 * by `@core/elements/style-scope.js` and adopted by the document before the tag is
 * defined, so its first render is already styled. A production build folds the same
 * scoped text into the application stylesheet instead, and declares the Element with
 * `styles: 'bundled'` so nothing here runs. ADR-0119.
 *
 * Adopted rather than inserted as a `<style>`, because adopted sheets follow every
 * stylesheet in the document. Tailwind's browser build declares its layer order in a
 * `<style>` it injects later, and an element inserted before that would declare
 * `components` first and sort it under preflight.
 */

import { scopeStylesheet } from '@core/elements/style-scope.js';

/**
 * One entry per stylesheet URL, holding the tag it is scoped to and the sheet the
 * document adopted. The promise is cached, so a revision that arrives while the first
 * request is in flight lands after it rather than being overwritten by it.
 *
 * @type {Map<string, { tag: string, sheet: Promise<CSSStyleSheet> }>}
 */
const byUrl = new Map();

/**
 * Fetch, scope and adopt the stylesheet an Element owns.
 *
 * Called only by `defineComponent`, which awaits it beside the template and before
 * `customElements.define`.
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
 * Replace the rules of an adopted stylesheet in place.
 *
 * Development only. The sheet keeps its position among the adopted sheets and every
 * host keeps its state, because nothing but the rules changes. A stylesheet that cannot
 * be scoped throws before anything is replaced, so a file caught half-written leaves the
 * rules the page already had.
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
