/**
 * Project the artifact report onto the entry document: the transfers the browser
 * is going to need, named in the document that starts them.
 *
 * The build computes the whole module graph — `chunks[].imports`,
 * `chunks[].dynamicImports` — validates it, and writes it to `artifact.json`. Until
 * this module existed nothing read it back. The document was produced by
 * `productionHtml`, a `transformIndexHtml` with `order: 'pre'`, which runs before a
 * single chunk has been emitted and therefore structurally cannot name one. So a
 * cold start discovered its own dependency graph one round trip at a time: fetch the
 * entry, evaluate it, learn the root module's URL, fetch that, evaluate it, learn the
 * next one. Around twenty serial round trips delivered ten kilobytes of JavaScript.
 *
 * Nothing here changes evaluation order. `@core/application/runtime.js` imports the
 * root module dynamically "because a static import is evaluated before any of the
 * above runs", and that constraint is about evaluation. A `modulepreload` moves only
 * the transfer: the bytes arrive while the seven startup steps run, and step 7 gets a
 * module that is already fetched and compiled. ADR-0080.
 *
 * Pure, and deliberately: report in, document out. A hint list is asserted without
 * running Vite over an application.
 */

import { parse, parseFragment, serialize } from 'parse5';

/** @import { ShellArtifactReport } from './artifact-report.mjs' */

/**
 * Where startup step 2 reads the application's policy from. `loadManifest` defaults
 * to this path and every artifact this toolchain builds emits the file there, so the
 * document can name it without learning anything about the application.
 */
const MANIFEST = '/app.manifest.json';

/**
 * One transfer the entry document starts. `integrity` is the digest the page's own
 * import map already pins for that URL: repeating it on the hint is what makes the
 * preloaded response the one the later module request consumes, rather than a second
 * copy fetched under different integrity metadata.
 *
 * @typedef {{ rel: 'modulepreload', href: string, integrity: string | null }
 *   | { rel: 'preload', href: string, as: 'fetch' }} EntryHint
 */

/**
 * The facts a hint list is derived from. A whole `ShellArtifactReport` satisfies it;
 * so does a literal in a test, which is the point of naming the subset.
 *
 * @typedef {Pick<ShellArtifactReport, 'entry' | 'chunks' | 'security'>} HintFacts
 */

/**
 * Every transfer the entry document can start before the entry module has run.
 *
 * Two groups, in the order the browser should begin them. The manifest first: it is
 * startup step 2, it is small, and until now it was not requested until the entry
 * chunk had been fetched and evaluated. Then the module graph — the entry's static
 * closure, which the browser needs before it may evaluate the entry at all, followed
 * by the root module and its own static closure, which is the one dynamic import the
 * document can predict, because `startApplication`'s last step always makes it.
 *
 * Route chunks are not here. Which route a visitor lands on is not a build fact, and
 * a document that preloaded all of them would trade a round trip for the whole
 * application's bytes. That chain is shortened where it is actually known — in the
 * router, which knows the levels a URL enters. Nothing there calls this yet: a
 * `RouteDef` carries an opaque `load` closure and neither side has a fact that maps a
 * route to the chunk that import resolves to. What does exist is the other half —
 * `app.manifest.json` groups its templates by chunk under the same closure rule this
 * uses, so a router that gained such a fact would have a list to start. ADR-0086.
 *
 * @param {HintFacts} facts
 * @returns {EntryHint[]}
 */
export function entryHints(facts) {
  const byPath = new Map(facts.chunks.map((chunk) => [chunk.path, chunk]));
  const entry = byPath.get(facts.entry);
  if (entry === undefined) {
    throw new Error(`entry-hints: the report names ${facts.entry}, which is not one of its chunks.`);
  }

  const integrity = new Map(facts.security.modules.map((module) => [module.path, module.integrity]));

  // The entry chunk itself is already a <script src> in the document; preloading it
  // a second time is a duplicate request in every browser that does not de-duplicate
  // a hint against a script tag it has not reached yet.
  const seen = new Set([entry.path]);

  /** @param {readonly string[]} roots @returns {string[]} */
  const closure = (roots) => {
    /** @type {string[]} */
    const found = [];
    const queue = [...roots];
    while (queue.length > 0) {
      const path = /** @type {string} */ (queue.shift());
      if (seen.has(path)) continue;
      seen.add(path);
      found.push(path);
      const chunk = byPath.get(path);
      if (chunk !== undefined) queue.push(...chunk.imports);
    }
    return found.sort((left, right) => left.localeCompare(right));
  };

  const statics = closure(entry.imports);
  const roots = closure(entry.dynamicImports);

  /** @type {EntryHint[]} */
  const hints = [{ rel: 'preload', href: MANIFEST, as: 'fetch' }];
  for (const path of [...statics, ...roots]) {
    hints.push({
      rel: 'modulepreload',
      href: `/${path}`,
      integrity: integrity.get(`/${path}`) ?? null,
    });
  }
  return hints;
}

/**
 * Write a hint list into the entry document, immediately before the module script
 * that starts the application.
 *
 * Before the script rather than after it, so the transfers are in flight by the time
 * the parser reaches the tag that needs them, and after the import map, which
 * `emitSecurity` has already placed there: an import map has to precede every module
 * load a document starts, and a `modulepreload` is one.
 *
 * @param {string} html The production document, import map already inlined.
 * @param {HintFacts} facts
 * @returns {string}
 */
export function withEntryHints(html, facts) {
  const document = /** @type {HintNode} */ (/** @type {unknown} */ (parse(html)));
  const head = findHead(document);
  if (head?.childNodes === undefined) {
    throw new Error('entry-hints: production HTML has no head element.');
  }
  const entryIndex = head.childNodes.findIndex(
    (node) => node.tagName === 'script' && attribute(node, 'type') === 'module',
  );
  if (entryIndex === -1) {
    throw new Error('entry-hints: production HTML has no module entry to hint for.');
  }

  const markup = entryHints(facts).map(tagFor).join('');
  const fragment = /** @type {HintNode} */ (/** @type {unknown} */ (parseFragment(markup)));
  head.childNodes.splice(entryIndex, 0, ...(fragment.childNodes ?? []));
  return serialize(/** @type {never} */ (document));
}

/**
 * @param {EntryHint} hint
 * @returns {string}
 */
function tagFor(hint) {
  // `crossorigin` on both kinds, and it is not decoration. A module script is always
  // fetched in CORS mode, and a `fetch()` of a same-origin JSON document defaults to
  // CORS mode with same-origin credentials; a hint without the attribute is a no-CORS
  // request, which the browser will not hand to either caller. It would fetch the
  // bytes twice and report the first copy as an unused preload.
  if (hint.rel === 'preload') {
    return `<link rel="preload" href="${hint.href}" as="${hint.as}" crossorigin>`;
  }
  const integrity = hint.integrity === null ? '' : ` integrity="${hint.integrity}"`;
  return `<link rel="modulepreload" href="${hint.href}" crossorigin${integrity}>`;
}

/**
 * @typedef {{ nodeName: string, tagName?: string, attrs?: Array<{ name: string, value: string }>, childNodes?: HintNode[] }} HintNode
 */

/**
 * @param {HintNode} node
 * @returns {HintNode | null}
 */
function findHead(node) {
  if (node.tagName === 'head') return node;
  for (const child of node.childNodes ?? []) {
    const found = findHead(child);
    if (found !== null) return found;
  }
  return null;
}

/**
 * @param {HintNode} node
 * @param {string} name
 * @returns {string | null}
 */
function attribute(node, name) {
  return node.attrs?.find((attr) => attr.name === name)?.value ?? null;
}
