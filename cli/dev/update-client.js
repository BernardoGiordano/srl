/**
 * The browser half of a development update, deciding what each changed URL means.
 *
 * Served at `/__updates/client.js` by `cli/dev/updates.mjs` and imported by the tag
 * that server injects into the entry document. It is never written into the file on
 * disk and never reaches production, so the bytes this origin sends and the bytes
 * nginx sends are the same.
 *
 * Four answers, in the order they cost the developer:
 *
 *   .html   a template revision. `reviseTemplate` recompiles the file and renders it
 *           into the hosts already showing it, so their fields, signals and
 *           subscriptions survive the edit (ADR-0111).
 *   .css    an Element's own stylesheet has its rules replaced in place (ADR-0119),
 *           and any other linked stylesheet is fetched again and swapped in place.
 *   .js     a component revision. `reviseComponentModule` runs the edited module
 *           again and installs its class body on the class the registry holds, or
 *           refuses and names what changed (ADR-0113).
 *   else    a reload.
 *
 * A fallback is always a reload rather than nothing. A `.css` file no `<link>` names
 * is reachable through an `@import` or a build step this cannot see, a template URL
 * that 404s has been deleted or renamed, a `.js` file that declares no component has
 * importers holding the bindings it exported, and an application served without an
 * import map cannot be reached through `@core/` at all. In each case the page is
 * stale, and a reload is the honest answer.
 *
 * `planUpdate` is separate from `applyUpdate` so the decision can be asserted
 * without a browser.
 */

/**
 * What the server sends, which is the URLs that changed, or a standing instruction
 * to start the page again. A browser gets the second when it reconnects across a gap
 * the server cannot describe.
 *
 * @typedef {{ changed?: string[], reload?: boolean }} Update
 */

/**
 * What this page will do about it.
 *
 * @typedef {{ reload: boolean, templates: string[], stylesheets: string[], modules: string[] }} UpdatePlan
 */

/** @returns {UpdatePlan} */
function reloading() {
  return { reload: true, templates: [], stylesheets: [], modules: [] };
}

/**
 * Sort one update into the four answers.
 *
 * A reload wins outright. Applying half an update and then reloading costs a
 * revision nobody sees, and the reload is the weaker guarantee of the two, so it
 * decides the whole batch.
 *
 * @param {Update} update
 * @returns {UpdatePlan}
 */
export function planUpdate(update) {
  if (update.reload === true) return reloading();

  /** @type {UpdatePlan} */
  const plan = { reload: false, templates: [], stylesheets: [], modules: [] };

  for (const url of update.changed ?? []) {
    const path = url.split('?')[0] ?? url;
    if (path.endsWith('.html')) plan.templates.push(url);
    else if (path.endsWith('.css')) plan.stylesheets.push(url);
    else if (path.endsWith('.js')) plan.modules.push(url);
    else return reloading();
  }

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
    if (await reviseElementStylesheet(url)) continue;
    if (!refreshStylesheet(url)) {
      location.reload();
      return;
    }
  }

  // Markup before code, because a batch that carries both is one edit to one
  // component and the render its class revision asks for should already be against
  // the new markup.
  if (plan.templates.length > 0) await reviseTemplates(plan.templates);
  if (plan.modules.length > 0) await reviseModules(plan.modules);
}

/**
 * Recompile edited templates into the hosts rendering them.
 *
 * The module is imported by the specifier the application's own source uses, so the
 * page's import map answers it and this file holds no second copy of the mount
 * table. An application served without that map, such as a bundle or a clone that
 * has not run `npm run importmap`, gets a reload instead.
 *
 * A file caught half-written throws inside `reviseTemplate` and changes nothing, so
 * the screen keeps the markup it had. That is worth a line in the console rather
 * than a reload, because the next save is a few seconds away and it will compile.
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
 * Run edited component modules again, in the page already running them.
 *
 * Every answer but "adopted" is a reload. A module that declares no component has
 * importers holding the bindings it exported, and nothing can hand them new ones. A
 * refusal names a change to the component's identity, such as its fields, its base
 * class or its reactive properties, that an element already on screen cannot take.
 * Both leave a stale page, and the console line says which it was.
 *
 * @param {string[]} urls
 * @returns {Promise<void>}
 */
async function reviseModules(urls) {
  let revise;
  try {
    ({ reviseComponentModule: revise } = await import('@core/elements/component.js'));
  } catch {
    location.reload();
    return;
  }

  for (const url of urls) {
    let revised = false;
    try {
      revised = await revise(url);
    } catch (cause) {
      console.info('[srl] %s needs a reload', url, cause);
    }
    if (!revised) {
      location.reload();
      return;
    }
  }
}

/**
 * Replace the rules of an Element's own stylesheet, or report that no Element owns it.
 *
 * The page adopted that sheet rather than linking it, so there is no `<link>` to swap;
 * the sheet keeps its place and every host keeps its state. A stylesheet that cannot be
 * scoped is a line in the console and not a reload, for the reason a template that
 * does not compile is one.
 *
 * @param {string} url
 * @returns {Promise<boolean>} Whether an Element on this page owns it.
 */
async function reviseElementStylesheet(url) {
  let revise;
  try {
    ({ reviseStylesheet: revise } = await import('@core/elements/stylesheet.js'));
  } catch {
    return false;
  }

  const response = await fetch(url, { cache: 'reload' });
  if (!response.ok) return false;

  try {
    return await revise(url, await response.text());
  } catch (cause) {
    console.error('[srl] %s was refused; the page kept the rules it had', url, cause);
    return true;
  }
}

/**
 * Swap every `<link>` that names a changed stylesheet, or report that none does.
 *
 * The fresh link is inserted beside the old one and the old one removed once the new
 * bytes have loaded, which keeps both the cascade order and the styles on screen.
 * Removing first is a frame of unstyled page.
 *
 * A pinned link is refused rather than swapped. `integrity` is a runtime control
 * here, and a URL with a revision query on it has no declared hash, so the swap would
 * fail the check and leave the page with no stylesheet at all.
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

/* ── Failures ──────────────────────────────────────────────────────────── */

/**
 * What the page tells `srl serve` about a failure. A `Diagnostic` with the URL the
 * browser knows in place of a file, which the server maps back to one. ADR-0125.
 *
 * @typedef {{
 *   severity: 'error' | 'warning',
 *   code: string,
 *   message: string,
 *   url: string | null,
 *   line: number | null,
 *   column: number | null,
 * }} PageDiagnostic
 */

/** Where the page posts each diagnostic. */
const DIAGNOSTICS = '/__updates/diagnostics';

/** A catalogue code, such as `runtime/startup`. */
const CODE = /^[a-z]+\/[a-z0-9-]+$/u;

/** One `url:line:column` in a stack line, in any engine's spelling. */
const FRAME = /(https?:\/\/[^\s()@]+?):(\d+):(\d+)/u;

/**
 * Where an error was thrown, from the first stack frame that names a URL.
 *
 * @param {unknown} error
 * @returns {{ url: string, line: number, column: number } | undefined}
 */
function stackFrame(error) {
  if (!(error instanceof Error) || typeof error.stack !== 'string') return undefined;
  for (const line of error.stack.split('\n')) {
    const match = FRAME.exec(line);
    if (match === null) continue;
    const [, url = '', row = '', column = ''] = match;
    return { url: new URL(url).pathname, line: Number(row), column: Number(column) };
  }
  return undefined;
}

/**
 * A dynamic import whose module, or one of its imports, did not load. Each engine words
 * it differently, and Chromium and Firefox name the URL.
 */
const DYNAMIC_IMPORT = /dynamically imported module|Importing a module script failed/u;

/**
 * The diagnostic for an error that reached the page.
 *
 * The code comes from the deepest error in the `cause` chain that carries one, because
 * the innermost coded error names the problem and the outer ones name where it
 * surfaced. An error with no code anywhere is `runtime/uncaught`. The place is the one
 * the browser reported, or else the error's own first stack frame.
 *
 * @param {unknown} error
 * @param {{ url?: string | null, line?: number | null, column?: number | null }} [at]
 * @returns {PageDiagnostic}
 */
export function diagnosticFromError(error, at = {}) {
  let code = 'runtime/uncaught';
  /** @type {unknown} */
  let current = error;
  while (current instanceof Error) {
    const own = /** @type {{ code?: unknown }} */ (current).code;
    if (typeof own === 'string' && CODE.test(own)) code = own;
    current = current.cause;
  }

  const message = error instanceof Error ? error.message : String(error);
  if (code === 'runtime/uncaught' && DYNAMIC_IMPORT.test(message)) {
    const named = /https?:\/\/\S+/u.exec(message)?.[0];
    return {
      severity: 'error',
      code: 'runtime/module-load',
      message: `${message}. The module or one of its imports did not load.`,
      url: named === undefined ? null : new URL(named).pathname,
      line: null,
      column: null,
    };
  }

  const frame =
    typeof at.url === 'string' && at.url !== ''
      ? { url: at.url, line: at.line ?? null, column: at.column ?? null }
      : (stackFrame(error) ?? { url: null, line: null, column: null });
  return { severity: 'error', code, message, ...frame };
}

/**
 * The warning for a template name nothing answers. `where` starts with the template's
 * URL when the template has one.
 *
 * @param {string} name
 * @param {string} where
 * @returns {PageDiagnostic}
 */
export function unknownNameDiagnostic(name, where) {
  const space = where.indexOf(' ');
  const head = space === -1 ? where : where.slice(0, space);
  const url = /^(?:\/|https?:)/u.test(head) ? new URL(head, 'http://page.invalid').pathname : null;
  const binding = url === null || space === -1 ? where : where.slice(space + 1);
  return {
    severity: 'warning',
    code: 'runtime/unknown-binding',
    message:
      `${binding} reads "${name}", which no local, member or template global answers, so it ` +
      `renders as undefined.`,
    url,
    line: null,
    column: null,
  };
}

/**
 * The diagnostic for one event the page queued, or null for an event that is not a
 * failure of the application, such as an image that did not load.
 *
 * @param {Event} event
 * @returns {PageDiagnostic | null}
 */
function diagnosticFromEvent(event) {
  if (event.type === 'unhandledrejection') {
    return diagnosticFromError(/** @type {PromiseRejectionEvent} */ (event).reason);
  }
  if (event instanceof ErrorEvent) {
    const url = event.filename === '' ? null : new URL(event.filename, location.href).pathname;
    return diagnosticFromError(event.error ?? event.message, {
      url,
      line: event.lineno || null,
      column: event.colno || null,
    });
  }
  const target = event.target;
  if (target instanceof HTMLScriptElement && target.type === 'module') {
    const url = target.src === '' ? null : new URL(target.src).pathname;
    return {
      severity: 'error',
      code: 'runtime/module-load',
      message:
        `${url ?? 'An inline module'} or a module it imports did not load, so nothing after ` +
        `it ran. The browser console names the request that failed.`,
      url,
      line: null,
      column: null,
    };
  }
  return null;
}

/**
 * Show an error in the page, in a panel of its own that the page's styles cannot
 * reach. Built from DOM calls rather than markup, so a page that enforces Trusted
 * Types still shows it.
 *
 * @param {PageDiagnostic} diagnostic
 */
function showOverlay(diagnostic) {
  let host = document.getElementById('srl-dev-overlay');
  if (host === null) {
    host = document.createElement('div');
    host.id = 'srl-dev-overlay';
    const root = host.attachShadow({ mode: 'open' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      section { position: fixed; inset: auto 1rem 1rem 1rem; z-index: 2147483647; max-height: 50vh;
        overflow: auto; padding: 1rem; border-radius: 0.5rem; background: #1f1f23; color: #f4f4f5;
        font: 13px/1.5 ui-monospace, monospace; box-shadow: 0 8px 32px rgb(0 0 0 / 40%); }
      header { display: flex; justify-content: space-between; margin-bottom: 0.5rem; color: #fca5a5; }
      button { all: unset; cursor: pointer; padding: 0 0.25rem; }
      ol { margin: 0; padding-left: 1.25rem; }
      li { white-space: pre-wrap; margin-top: 0.5rem; }
    `);
    root.adoptedStyleSheets = [sheet];

    const section = document.createElement('section');
    section.setAttribute('role', 'alert');
    const header = document.createElement('header');
    const title = document.createElement('strong');
    title.textContent = 'The page failed. srl serve printed the same lines.';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Dismiss');
    close.addEventListener('click', () => host?.remove());
    header.append(title, close);
    section.append(header, document.createElement('ol'));
    root.append(section);
    document.documentElement.append(host);
  }

  const item = document.createElement('li');
  const place =
    diagnostic.url === null
      ? ''
      : `${diagnostic.url}${diagnostic.line === null ? '' : `:${String(diagnostic.line)}`}  `;
  item.textContent = `${diagnostic.code}  ${place}\n${diagnostic.message}`;
  host.shadowRoot?.querySelector('ol')?.append(item);
}

/**
 * Report every failure this page sees to `srl serve`, and show each error in the page.
 *
 * The injected head script queues what fails before this module runs, which covers a
 * failure while the entry module evaluates. This drains the queue and takes its place.
 * A name no template can resolve is a warning, reported through the evaluator's hook
 * when the page reaches the library by path. Each problem is reported once per page.
 *
 * @returns {Promise<void>}
 */
export async function watchFailures() {
  /** @type {Set<string>} */
  const seen = new Set();

  /** @param {PageDiagnostic | null} diagnostic */
  const report = (diagnostic) => {
    if (diagnostic === null) return;
    const key = `${diagnostic.code}\0${diagnostic.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    void fetch(DIAGNOSTICS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(diagnostic),
      keepalive: true,
    }).catch(() => undefined);
    if (diagnostic.severity === 'error') showOverlay(diagnostic);
  };

  const queue = /** @type {{ __srlFailures?: { push: (event: Event) => void } | Event[] }} */ (globalThis);
  /** @type {Event[]} */
  const queued = Array.isArray(queue.__srlFailures) ? queue.__srlFailures : [];
  queue.__srlFailures = { push: (/** @type {Event} */ event) => report(diagnosticFromEvent(event)) };
  for (const event of queued) report(diagnosticFromEvent(event));

  try {
    const { reportUnknownNames } = await import('@core/template/expression.js');
    reportUnknownNames((name, where) => report(unknownNameDiagnostic(name, where)));
  } catch {
    // A page without the library's import map has no evaluator to hook.
  }
}
