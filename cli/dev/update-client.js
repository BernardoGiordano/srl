/**
 * The browser half of a development update: what each changed URL means.
 *
 * Served at `/__updates/client.js` by `cli/dev/updates.mjs` and imported by the tag
 * that server injects into the entry document. It is never written into the file on
 * disk and never reaches production, so the bytes this origin sends and the bytes
 * nginx sends are the same.
 *
 * Three answers, in the order they cost the developer:
 *
 *   .html   a template revision. `reviseTemplate` recompiles the file and renders it
 *           into the hosts already showing it, so their fields, signals and
 *           subscriptions survive the edit (ADR-0111).
 *   .css    the linked stylesheet is fetched again and swapped in place.
 *   else    a reload, which is what this server did for everything until now.
 *
 * A fallback is always a reload rather than nothing. A `.css` file no `<link>` names
 * is reachable through an `@import` or a build step this cannot see, a template URL
 * that 404s has been deleted or renamed, and an application served without an import
 * map cannot be reached through `@core/` at all. In each case the page is stale, and
 * the reload the developer would have got anyway is the honest answer.
 *
 * `planUpdate` is separate from `applyUpdate` so the decision can be asserted
 * without a browser.
 */

/**
 * What the server sends: the URLs that changed, or a standing instruction to start
 * the page again — which is what a browser gets when it reconnects across a gap the
 * server can no longer describe.
 *
 * @typedef {{ changed?: string[], reload?: boolean }} Update
 */

/**
 * What this page will do about it.
 *
 * @typedef {{ reload: boolean, templates: string[], stylesheets: string[] }} UpdatePlan
 */

/**
 * Sort one update into the three answers.
 *
 * A reload wins outright. Applying half an update and then reloading costs a
 * revision nobody sees, and the reload is the weaker guarantee of the two, so it
 * decides the whole batch.
 *
 * @param {Update} update
 * @returns {UpdatePlan}
 */
export function planUpdate(update) {
  /** @type {UpdatePlan} */
  const plan = { reload: update.reload === true, templates: [], stylesheets: [] };
  if (plan.reload) return plan;

  for (const url of update.changed ?? []) {
    const path = url.split('?')[0] ?? url;
    if (path.endsWith('.html')) plan.templates.push(url);
    else if (path.endsWith('.css')) plan.stylesheets.push(url);
    else plan.reload = true;
  }

  if (plan.reload) return { reload: true, templates: [], stylesheets: [] };
  return plan;
}

/**
 * Apply one update to this page.
 *
 * @param {Update} update
 * @returns {Promise<void>}
 */
export async function applyUpdate(update) {
  const plan = planUpdate(update);
  if (plan.reload) {
    location.reload();
    return;
  }

  for (const url of plan.stylesheets) {
    if (!refreshStylesheet(url)) {
      location.reload();
      return;
    }
  }

  if (plan.templates.length > 0) await reviseTemplates(plan.templates);
}

/**
 * Recompile edited templates into the hosts rendering them.
 *
 * The module is imported by the specifier the application's own source uses, so the
 * page's import map answers it and this file holds no second copy of the mount
 * table. An application served without that map — a bundle, or a clone that has not
 * run `npm run importmap` — gets a reload instead.
 *
 * A file caught half-written throws inside `reviseTemplate` and changes nothing, so
 * the screen keeps the markup it had. That is worth a line in the console and not a
 * reload: the next save is a few seconds away and it will compile.
 *
 * @param {string[]} urls
 * @returns {Promise<void>}
 */
async function reviseTemplates(urls) {
  let revise;
  try {
    ({ reviseTemplate: revise } = await import('@core/template/template.js'));
  } catch {
    location.reload();
    return;
  }

  for (const url of urls) {
    // `reload` rather than the default, because the response that is already in the
    // browser cache is the file before the edit and `no-cache` only requires a
    // revalidation this fetch would otherwise be free to skip.
    const response = await fetch(url, { cache: 'reload' });
    if (!response.ok) {
      location.reload();
      return;
    }

    try {
      revise(url, await response.text());
    } catch (cause) {
      console.error('[srl] %s did not compile; the page kept the markup it had', url, cause);
    }
  }
}

/**
 * Swap every `<link>` that names a changed stylesheet, or report that none does.
 *
 * The fresh link is inserted beside the old one and the old one removed once the new
 * bytes have loaded, which keeps both the cascade order and the styles on screen —
 * removing first is a frame of unstyled page.
 *
 * A pinned link is refused rather than swapped: `integrity` is a runtime control
 * here, and a URL with a revision query on it has no declared hash, so the swap
 * would fail the check and leave the page with no stylesheet at all.
 *
 * @param {string} url
 * @returns {boolean} Whether this page had it linked.
 */
function refreshStylesheet(url) {
  const href = new URL(url, location.origin).href;
  const links = /** @type {HTMLLinkElement[]} */ ([
    ...document.querySelectorAll('link[rel~="stylesheet"]'),
  ]).filter((link) => link.href.split('?')[0] === href);

  if (links.length === 0) return false;
  if (links.some((link) => link.integrity !== '')) return false;

  for (const link of links) {
    const fresh = /** @type {HTMLLinkElement} */ (link.cloneNode());
    fresh.href = `${href}?srl-revision=${String(Date.now())}`;
    fresh.addEventListener('load', () => link.remove(), { once: true });
    fresh.addEventListener(
      'error',
      () => {
        fresh.remove();
        location.reload();
      },
      { once: true },
    );
    link.after(fresh);
  }

  return true;
}
