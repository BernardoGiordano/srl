/**
 * One interpretation of an application's messages.
 *
 *   node cli/checks/message-check.mjs [--app example] [--json] [--write]
 *
 * It owns which bundles an application ships and which sources each one answers for,
 * every key a bundle declares, every key the source names in JavaScript and in markup
 * with the position of the literal, and what a reference resolves to. A reference
 * resolves to a message, a plural family, a set of keys claimed by a computed prefix,
 * or nothing.
 *
 * Comparing catalogs with catalogs answers the wrong question. Reading every locale
 * file and asking whether the translations agree with the default one finds a key
 * renamed in one language, and cannot find the thing that actually reaches a user, a
 * reference nothing answers. `t('orders.titel')` passes every catalog comparison and
 * renders `orders.titel` in the page, in every language.
 *
 * Three consumers need the same answer, the repository verifier, `srl check messages`
 * in an installed application, and the editor underlining the key as it is typed.
 * Each would otherwise interpret a catalog itself. Flattening, the `$` comment rule,
 * plural families and which bundle a file's references belong to are stated here
 * once. ADR-0117.
 *
 * It does not translate, format, or choose a locale, and it never deletes a key. A
 * computed reference is reported as the claim it is, and an entry no reference names
 * is a warning, because a catalog is also written to by hand.
 */

import { writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

import {
  FOR_HEAD,
  INTERPOLATION,
  classifyAttributeName,
} from '@srljs/core/lib/core/template/dialect.js';
import { parseExpression } from '@srljs/core/lib/core/template/expression-parser.js';

import { parseTemplate } from '../checks/template-check.mjs';
import { error, info, warning } from '../diagnostics/index.mjs';
import { REPO, exists, readText } from '../layout.mjs';
import { COMPONENTS, LIB, urlToFile } from '../package/interface.mjs';
import { parseSource } from '../project-model/parse.mjs';

/**
 * @import { Diagnostic } from '../diagnostics/types.js'
 * @import { ExprNode } from '@srljs/core/lib/core/template/types.js'
 * @import { Application, ProjectModel } from '../project-model/types.js'
 * @import { MessageBundle, MessageCatalog, MessageModel, MessageReference } from './types.js'
 */

/**
 * The part of an application's manifest this module reads. The whole document is
 * admitted by `@core/remotes/manifest-policy.js` where that matters, at startup and in
 * the verifier's own admission, so nothing here validates it a second time.
 *
 * @typedef {{
 *   i18n?: { defaultLocale?: string, supportedLocales?: string[], bundles?: string[] },
 *   remotes?: Array<{ name?: string, url?: string, locales?: string[] }>,
 * }} ManifestMessages
 */

/**
 * `{name}` in a pattern. The second statement of the grammar in
 * `source/lib/core/localization/i18n.js`, which cannot be imported from Node because it
 * reaches for signals and the import map. cli/test/message-catalog.test.mjs pins the
 * two against each other.
 */
const PLACEHOLDER = /\{(\w+)\}/gu;

/**
 * A key written as a string, or the start of one. The same shape
 * cli/project-model/parse.mjs collects from JavaScript, for the same weaker question of
 * whether this key is named anywhere at all. A string ending in a dot is a family, so
 * whatever follows it is computed and every key under it counts as named.
 */
const DOTTED = /^[A-Za-z_$][\w$-]*(?:\.[\w$-]+)*\.[\w$-]*$/u;

/** The plural categories `Intl.PluralRules` selects, which is what a variant may be named. */
const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'];

/**
 * Every message fact about one application.
 *
 * The model is the source of references, so the parse that found an element definition is
 * the parse that found `t('orders.title')`. Templates are read here, because a template is
 * markup rather than a module and the model records only which files they are.
 *
 * @param {Application} app
 * @param {ProjectModel} model
 * @returns {Promise<MessageModel>}
 */
export async function readMessages(app, model) {
  const bundles = await readBundles(app, await readManifest(app));

  /** @type {MessageReference[]} */
  const references = [];

  /** @type {Set<string>} */
  const literals = new Set();

  for (const module of model.modules.values()) {
    if (!isAuthored(module.path, app)) continue;
    for (const reference of module.messages) {
      references.push({ ...reference, file: module.path, form: 'javascript' });
    }
    for (const literal of module.literals) literals.add(literal);
  }

  for (const template of model.templates.values()) {
    if (!isAuthored(template.path, app)) continue;
    const read = await templateReferences(template.path);
    references.push(...read.references);
    for (const literal of read.literals) literals.add(literal);
  }

  references.sort((left, right) =>
    left.file === right.file ? left.line - right.line : left.file.localeCompare(right.file),
  );

  return { app, bundles, references, literals };
}

/**
 * Whether a file's message references are this application's to answer for.
 *
 * A suite owns its own message table. `configureI18n` takes whatever a test hands it,
 * and a suite about fallback asks for a key it has deliberately not declared. Vendored
 * bytes are nobody's authored source, and a minified module full of one-letter
 * functions has a `t` that is not this one. The model carries both, and the rules skip
 * them.
 *
 * Decided on the path relative to the root the file is under, meaning the application,
 * the library or the collection, rather than to the repository. An absolute path is
 * somebody's checkout, and a repository that happens to sit under a directory called
 * `test` is not a repository of tests.
 *
 * @param {string} path
 * @param {Application} app
 * @returns {boolean}
 */
function isAuthored(path, app) {
  const inside =
    [app.dir, LIB, COMPONENTS]
      .map((root) => relative(root, path))
      .find((candidate) => !candidate.startsWith('..')) ?? relative(REPO, path);
  const parts = inside.split(sep);
  return !parts.includes('test') && !parts.includes('vendor') && !inside.endsWith('.test.js');
}

/**
 * The manifest, or an empty one.
 *
 * An application with no manifest, or one with no `i18n` block, registers no bundles.
 * That is a finding for `npm run verify`, which is the check that owns whether a manifest
 * exists at all; here it is an application with nothing to resolve against, and every
 * rule below says nothing rather than everything.
 *
 * @param {Application} app
 * @returns {Promise<ManifestMessages>}
 */
async function readManifest(app) {
  const path = join(app.dir, 'app.manifest.json');
  if (!(await exists(path))) return {};
  try {
    const document = /** @type {unknown} */ (JSON.parse(await readText(path)));
    return /** @type {ManifestMessages} */ (document);
  } catch {
    return {};
  }
}

/**
 * The bundles an application ships, and the sources each answers for.
 *
 * Read from the manifest rather than from whatever `i18n` directories exist, because
 * the manifest is what the browser loads. A folder of translations nothing registers is
 * not a bundle, and a bundle pattern naming nothing is a finding rather than an
 * absence.
 *
 * A remote's bundle answers for the remote's own directory. The shell's answers for
 * everything, because every locale the shell registers is in the table before a remote
 * loads, and nothing in the shell may depend on a remote having loaded.
 *
 * @param {Application} app
 * @param {ManifestMessages} manifest
 * @returns {Promise<MessageBundle[]>}
 */
async function readBundles(app, manifest) {
  /** @type {MessageBundle[]} */
  const bundles = [];
  if (manifest.i18n === undefined) return bundles;

  const defaultLocale = String(manifest.i18n.defaultLocale ?? 'en');
  /** @type {string[]} */
  const supportedLocales = (manifest.i18n.supportedLocales ?? [defaultLocale]).map(String);

  for (const pattern of manifest.i18n.bundles ?? []) {
    bundles.push(
      await readBundle({
        app,
        name: 'application',
        pattern: String(pattern),
        scope: null,
        defaultLocale,
        supportedLocales,
      }),
    );
  }

  for (const remote of manifest.remotes ?? []) {
    for (const pattern of remote.locales ?? []) {
      bundles.push(
        await readBundle({
          app,
          name: String(remote.name),
          pattern: String(pattern),
          scope: dirname(urlToFile(app.dir, String(remote.url ?? ''))),
          defaultLocale,
          supportedLocales,
        }),
      );
    }
  }

  return bundles;
}

/**
 * @param {{ app: Application, name: string, pattern: string, scope: string | null,
 *   defaultLocale: string, supportedLocales: string[] }} input
 * @returns {Promise<MessageBundle>}
 */
async function readBundle(input) {
  /** @type {Map<string, MessageCatalog>} */
  const locales = new Map();

  for (const locale of input.supportedLocales) {
    const path = urlToFile(input.app.dir, input.pattern.replace('{locale}', locale));
    if (!(await exists(path))) continue;
    locales.set(locale, await readCatalog(path, locale));
  }

  return {
    name: input.name,
    pattern: input.pattern,
    supportedLocales: input.supportedLocales,
    scope: input.scope,
    dir: dirname(urlToFile(input.app.dir, input.pattern.replace('{locale}', input.defaultLocale))),
    defaultPath: urlToFile(input.app.dir, input.pattern.replace('{locale}', input.defaultLocale)),
    defaultLocale: input.defaultLocale,
    locales,
  };
}

/**
 * One locale file, flattened exactly as the runtime flattens it, with the position of
 * every key.
 *
 * Nested for translators, dotted at the point of use, and a key beginning with `$` is a
 * note that never becomes a message. Positions come from the same pass rather than from a
 * search afterwards, so a finding about `orders.title` points at the line that declares
 * it and not at the first line that happens to contain the word.
 *
 * @param {string} path
 * @param {string} locale
 * @returns {Promise<MessageCatalog>}
 */
async function readCatalog(path, locale) {
  const text = await readText(path);
  /** @type {Map<string, { value: string, line: number, column: number }>} */
  const keys = new Map();

  const document = JSON.parse(text);
  const scan = scanCatalog(text);

  /** @param {unknown} value @param {string} prefix */
  const walk = (value, prefix) => {
    if (typeof value !== 'object' || value === null) return;
    for (const [name, child] of Object.entries(value)) {
      if (name.startsWith('$')) continue;
      const key = prefix === '' ? name : `${prefix}.${name}`;
      if (typeof child === 'string' || typeof child === 'number') {
        keys.set(key, { value: String(child), ...positionOf(text, scan.keys.get(key) ?? 0) });
      } else walk(child, key);
    }
  };
  walk(document, '');

  return { path, locale, text, keys, objects: scan.objects };
}

/**
 * The document's own punctuation, meaning where every key is written and where every
 * object ends.
 *
 * A scan rather than a parse, because the file has already been through `JSON.parse`
 * and what is left to find is position. Both answers come from one pass. A finding
 * points at the line that declares a key, and an extraction inserts a new key inside
 * the object that already holds its siblings instead of reformatting the file around
 * it.
 *
 * @param {string} text
 * @returns {{ keys: Map<string, number>, objects: Map<string, { end: number, entries: number }> }}
 */
function scanCatalog(text) {
  const TOKEN = /\s+|("(?:[^"\\]|\\.)*")|([{}[\]:,])|([^\s{}[\]:,]+)/gyu;

  /** @type {Array<{ text: string, at: number }>} */
  const tokens = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < text.length) {
    const at = TOKEN.lastIndex;
    const match = TOKEN.exec(text);
    if (match === null) break;
    if (match[0].trim() !== '') tokens.push({ text: match[0], at });
  }

  /** @type {Map<string, number>} */
  const keys = new Map();
  /** @type {Map<string, { end: number, entries: number }>} */
  const objects = new Map();
  let index = 0;

  /** @param {string} path */
  const object = (path) => {
    index += 1;
    let entries = 0;
    while (index < tokens.length && tokens[index]?.text !== '}') {
      const name = tokens[index];
      if (name === undefined || !name.text.startsWith('"')) {
        index += 1;
        continue;
      }
      entries += 1;
      const child = path === '' ? JSON.parse(name.text) : `${path}.${JSON.parse(name.text)}`;
      index += 2;
      const value = tokens[index];
      if (value?.text === '{') object(child);
      else if (value?.text === '[') array();
      else {
        keys.set(child, name.at);
        index += 1;
      }
      if (tokens[index]?.text === ',') index += 1;
    }
    objects.set(path, { end: tokens[index]?.at ?? text.length, entries });
    index += 1;
  };

  const array = () => {
    let depth = 0;
    do {
      const token = tokens[index]?.text;
      if (token === '[') depth += 1;
      if (token === ']') depth -= 1;
      index += 1;
    } while (index < tokens.length && depth > 0);
  };

  if (tokens[0]?.text === '{') object('');
  return { keys, objects };
}

/**
 * Every message one template names, with the position of the key inside the file, and
 * every dotted string it writes down.
 *
 * The markup scan and the expression grammar are the template checker's and the
 * dialect's. A template that does not parse is the checker's finding to report rather
 * than this module's, so an unreadable expression yields no reference rather than a
 * second syntax error in a different voice.
 *
 * @param {string} path
 * @param {string} [text] The buffer to read instead of the file, for an unsaved edit.
 * @returns {Promise<{ references: MessageReference[], literals: Set<string> }>}
 */
async function templateReferences(path, text) {
  const source = text ?? (await readText(path));
  /** @type {MessageReference[]} */
  const references = [];
  /** @type {Set<string>} */
  const literals = new Set();

  /** @param {string} expression @param {number} at */
  const read = (expression, at) => {
    /** @type {ExprNode} */
    let ast;
    try {
      ast = parseExpression(expression, path);
    } catch {
      // A template mid-edit, or an expression the checker is already refusing. One
      // voice per failure, so no reference here and no second syntax error from this
      // module.
      return;
    }
    for (const literal of expressionLiterals(ast)) literals.add(literal);
    for (const call of messageCalls(ast)) {
      references.push({
        ...call.reference,
        ...positionOf(source, keyOffset(source, expression, at, call.at, call.reference.key)),
        file: path,
        form: 'template',
      });
    }
  };

  /** @param {string} text @param {number} at */
  const interpolations = (text, at) => {
    for (const match of text.matchAll(INTERPOLATION)) {
      read(match[1] ?? '', at + match.index + 2);
    }
  };

  /** @param {import('../checks/template-check.mjs').TemplateNode[]} nodes */
  const walk = (nodes) => {
    for (const node of nodes) {
      if (node.kind === 'text') {
        interpolations(node.value, node.at);
        continue;
      }

      for (const attribute of node.attributes) {
        if (attribute.name.startsWith('*')) {
          if (attribute.name === '*for') {
            const head = FOR_HEAD.exec(attribute.value);
            const iterable = head?.[2];
            if (iterable !== undefined) {
              read(iterable, attribute.at + attribute.value.indexOf(iterable));
            }
          } else if (attribute.name !== '*fragment') {
            read(attribute.value, attribute.at);
          }
          continue;
        }

        const classified = classifyAttributeName(attribute.name);
        if (classified.kind === 'binding' || classified.kind === 'event') {
          read(attribute.value, attribute.at);
        } else {
          interpolations(attribute.value, attribute.at);
        }
      }

      walk(node.children);
    }
  };

  walk(parseTemplate(source, path));
  return { references, literals };
}

/**
 * The sub-expressions of one node, which is all a walk over this grammar needs. Written
 * out rather than reflected over, so a node the dialect adds is a case to add here rather
 * than a silent hole.
 *
 * @param {ExprNode} node
 * @returns {ExprNode[]}
 */
function children(node) {
  switch (node.kind) {
    case 'member':
      return [node.object];
    case 'index':
      return [node.object, node.index];
    case 'call':
      return [node.callee, ...node.args];
    case 'unary':
      return [node.operand];
    case 'binary':
      return [node.left, node.right];
    case 'conditional':
      return [node.test, node.consequent, node.alternate];
    case 'array':
      return node.items;
    case 'object':
      return node.entries.map((entry) => entry.value);
    case 'assign':
      return [node.target, node.value];
    case 'raw':
      return [node.operand];
    default:
      return [];
  }
}

/**
 * Every dotted string an expression writes. `[.label-key]="'stat.up'"` names a message
 * that the call resolving it cannot be seen from.
 *
 * @param {ExprNode} node
 * @returns {string[]}
 */
function expressionLiterals(node) {
  const here =
    node.kind === 'literal' && typeof node.value === 'string' && DOTTED.test(node.value)
      ? [node.value]
      : [];
  return [...here, ...children(node).flatMap(expressionLiterals)];
}

/**
 * Every `t(...)` in one expression, as a reference and the offset of its callee.
 *
 * `t` is a template global rather than an import, so there is no specifier to check
 * against: inside markup the name is the library's unless an application registers a
 * global of its own over it, which `npm run verify` refuses for every other reason.
 *
 * @param {ExprNode} node
 * @returns {Array<{ reference: { key: string | null, prefix: string | null,
 *   params: string[] | null, count: boolean }, at: number }>}
 */
function messageCalls(node) {
  /** @type {Array<{ reference: { key: string | null, prefix: string | null,
   *   params: string[] | null, count: boolean }, at: number }>} */
  const found = [];

  if (node.kind === 'call' && node.callee.kind === 'name' && node.callee.name === 't') {
    const [first, second] = node.args;
    const params = expressionParams(second);
    const at = node.callee.at;
    for (const branch of first === undefined ? [] : keyBranches(first)) {
      found.push({ reference: { ...expressionKey(branch), ...params }, at });
    }
  }

  return [...found, ...children(node).flatMap(messageCalls)];
}

/**
 * The key an expression names, written out or as the static start of a computed
 * one.
 *
 * @param {ExprNode} node
 * @returns {{ key: string | null, prefix: string | null }}
 */
function expressionKey(node) {
  if (node.kind === 'literal' && typeof node.value === 'string') {
    return { key: node.value, prefix: null };
  }

  if (node.kind === 'binary' && node.operator === '+') {
    const left = expressionKey(node.left);
    return { key: null, prefix: left.key ?? left.prefix };
  }

  return { key: null, prefix: null };
}

/**
 * Both branches of `t(open ? 'a.open' : 'a.closed')` are written down, so both are
 * references and either may be misspelled.
 *
 * @param {ExprNode} node
 * @returns {ExprNode[]}
 */
function keyBranches(node) {
  if (node.kind !== 'conditional') return [node];
  return [...keyBranches(node.consequent), ...keyBranches(node.alternate)];
}

/**
 * The parameters a call passes, when it passes an object literal. Null is "written, and
 * not readable from here", and no placeholder conclusion may be drawn from it.
 *
 * @param {ExprNode | undefined} node
 * @returns {{ params: string[] | null, count: boolean }}
 */
function expressionParams(node) {
  if (node === undefined) return { params: [], count: false };
  if (node.kind !== 'object') return { params: null, count: false };
  const params = node.entries.map((entry) => entry.key);
  return { params, count: params.includes('count') };
}

/**
 * The offset of the key literal, so a finding underlines the string that is wrong rather
 * than the call around it. Falls back to the callee when the key is computed.
 *
 * @param {string} source
 * @param {string} expression
 * @param {number} at Offset of the expression inside the file.
 * @param {number} callee Offset of `t` inside the expression.
 * @param {string | null} key
 * @returns {number}
 */
function keyOffset(source, expression, at, callee, key) {
  if (key === null) return at + callee;
  for (const quote of ["'", '"']) {
    const literal = expression.indexOf(`${quote}${key}${quote}`, callee);
    if (literal !== -1) return at + literal + 1;
  }
  return at + callee;
}

/** @param {string} source @param {number} offset @returns {{ line: number, column: number }} */
function positionOf(source, offset) {
  const before = source.slice(0, offset);
  const line = before.split('\n').length;
  const column = offset - (before.lastIndexOf('\n') + 1) + 1;
  return { line, column };
}

/* ── Resolution ────────────────────────────────────────────────────────── */

/**
 * The bundles a file's references may resolve against, nearest first.
 *
 * A file inside a remote reaches its own bundle and the shell's, because the shell
 * registered its translations before the remote was fetched. A file outside every
 * remote reaches only the shell's. A remote loads on navigation, so a shell key
 * answered by a remote's bundle renders correctly after one route and raw before
 * it.
 *
 * @param {MessageModel} messages
 * @param {string} file
 * @returns {MessageBundle[]}
 */
export function bundlesFor(messages, file) {
  const own = messages.bundles.filter(
    (bundle) => bundle.scope !== null && file.startsWith(bundle.scope + sep),
  );
  const shell = messages.bundles.filter((bundle) => bundle.scope === null);
  return [...own, ...shell];
}

/**
 * What a reference resolves to, by the runtime's own rule.
 *
 * `t('cart.items', { count })` asks `Intl.PluralRules` for a category and reads
 * `cart.items.other` when the selected one is absent, so a plural family answers a
 * reference that no flat key answers. Everything else is the key itself.
 *
 * @param {MessageModel} messages
 * @param {MessageReference} reference
 * @returns {{ bundle: MessageBundle, value: string } | null}
 */
export function resolveMessage(messages, reference) {
  if (reference.key === null) return null;

  for (const bundle of bundlesFor(messages, reference.file)) {
    const catalog = bundle.locales.get(bundle.defaultLocale);
    if (catalog === undefined) continue;

    const exact = catalog.keys.get(reference.key);
    if (exact !== undefined) return { bundle, value: exact.value };

    if (reference.count) {
      for (const category of PLURAL_CATEGORIES) {
        const variant = catalog.keys.get(`${reference.key}.${category}`);
        if (variant !== undefined) return { bundle, value: variant.value };
      }
    }
  }

  return null;
}

/**
 * Every key a reference claims, which is the one it names, its plural family, or the
 * keys under the prefix a computed reference starts from.
 *
 * @param {MessageModel} messages
 * @param {MessageReference} reference
 * @param {MessageBundle} bundle
 * @returns {string[]}
 */
function claimedKeys(messages, reference, bundle) {
  if (!bundlesFor(messages, reference.file).includes(bundle)) return [];
  const catalog = bundle.locales.get(bundle.defaultLocale);
  if (catalog === undefined) return [];

  if (reference.prefix !== null) {
    return [...catalog.keys.keys()].filter((key) => key.startsWith(reference.prefix ?? ''));
  }

  if (reference.key === null) return [];
  const family = PLURAL_CATEGORIES.map((category) => `${reference.key}.${category}`);
  return [reference.key, ...family].filter((key) => catalog.keys.has(key));
}

/* ── Findings ──────────────────────────────────────────────────────────── */

/**
 * Every message rule, as findings.
 *
 * An unanswered reference is an error, because it reaches a user as a raw key in every
 * language and nothing else reports it. A key nothing names is a warning, because a
 * catalog is written by hand and a key may be one release ahead of the screen that will
 * show it. A computed reference is neither, and is reported for what it claims, so that
 * a report says why forty keys count as used.
 *
 * @param {MessageModel} messages
 * @returns {Diagnostic[]}
 */
export function messageFindings(messages) {
  /** @type {Diagnostic[]} */
  const found = [];
  const group = messages.app.name;

  for (const bundle of messages.bundles) {
    const label = bundle.name === 'application' ? 'the application' : `remote "${bundle.name}"`;
    const base = bundle.locales.get(bundle.defaultLocale);

    if (base === undefined) {
      found.push(
        error(
          'messages/no-default-locale',
          `${label} registers ${bundle.pattern} and ships no ${bundle.defaultLocale}.json. Every ` +
            `locale falls back to the default one key by key, so without it a partial translation ` +
            `renders raw keys.`,
          { group, file: bundle.defaultPath },
        ),
      );
      continue;
    }

    for (const locale of bundle.supportedLocales) {
      if (locale === bundle.defaultLocale || bundle.locales.has(locale)) continue;
      found.push(
        warning(
          'messages/locale-absent',
          `${label} ships no ${locale}.json for ${bundle.pattern}, so ${locale} renders in ` +
            `${bundle.defaultLocale} entirely. Fallback is per key, and this is every key.`,
          { group, file: bundle.defaultPath },
        ),
      );
    }

    for (const [locale, catalog] of bundle.locales) {
      if (locale === bundle.defaultLocale) continue;

      for (const [key, entry] of catalog.keys) {
        if (base.keys.has(key) || isPluralVariant(key, base.keys)) continue;
        found.push(
          error(
            'messages/orphan-key',
            `"${key}" is absent from ${bundle.defaultLocale}.json. Either a typo, or a message ` +
              `renamed in the default locale only: it renders correctly in ${locale} and as a raw ` +
              `key in every other language.`,
            { group, file: catalog.path, line: entry.line, column: entry.column },
          ),
        );
      }

      const untranslated = [...base.keys.keys()].filter((key) => !catalog.keys.has(key));
      found.push(
        info(
          'messages/locale',
          `${String(catalog.keys.size)} key(s), ${String(untranslated.length)} untranslated`,
          { group, file: catalog.path },
        ),
      );
    }
  }

  /** @type {Map<MessageBundle, Set<string>>} */
  const claimed = new Map(messages.bundles.map((bundle) => [bundle, new Set()]));
  /** Every family a computed reference starts from, reported once however often it is written. */
  const computed = new Set();

  for (const reference of messages.references) {
    for (const bundle of messages.bundles) {
      for (const key of claimedKeys(messages, reference, bundle)) {
        claimed.get(bundle)?.add(key);
      }
    }
    if (reference.key === null && reference.prefix !== null) computed.add(reference.prefix);
  }

  found.push(...referenceFindings(messages, messages.references));

  for (const bundle of messages.bundles) {
    const base = bundle.locales.get(bundle.defaultLocale);
    if (base === undefined) continue;
    const used = claimed.get(bundle) ?? new Set();

    for (const [key, entry] of base.keys) {
      if (used.has(key) || isNamed(messages.literals, key)) continue;
      found.push(
        warning(
          'messages/unused-key',
          `"${key}" is named by no source this bundle answers for. Either the screen that used it ` +
            `was deleted, or the key is reached by a computed reference this check cannot read.`,
          { group, file: base.path, line: entry.line, column: entry.column },
        ),
      );
    }
  }

  if (computed.size > 0) {
    const reach = new Set(
      [...claimed.values()].flatMap((keys) =>
        [...keys].filter((key) => [...computed].some((prefix) => key.startsWith(prefix))),
      ),
    );
    found.push(
      info(
        'messages/computed-key',
        `${String(computed.size)} computed key(s) reach ${String(reach.size)} catalog entries ` +
          `between them (${[...computed].sort().join(' ')}). No check can say a built key ` +
          `exists, and what they may reach is not reported as unused.`,
        { group },
      ),
    );
  }

  found.push(
    info(
      'messages/references',
      `${String(messages.references.length)} message reference(s) across ` +
        `${String(new Set(messages.references.map((reference) => reference.file)).size)} file(s)`,
      { group },
    ),
  );

  return found;
}

/**
 * Whether any source writes this key down outside a call, as a property, a constant, a
 * branch of a lookup table, or the family a template head names.
 *
 * The strong rule, that a reference resolves to nothing, reads call sites only, because
 * that is the question with a wrong answer in the page. This is the weak one, and it
 * decides whether to say a catalog entry looks abandoned, so it errs towards
 * silence.
 *
 * @param {Set<string>} literals
 * @param {string} key
 * @returns {boolean}
 */
function isNamed(literals, key) {
  for (const literal of literals) {
    if (literal.endsWith('.') ? key.startsWith(literal) : key === literal) return true;
    if (!literal.endsWith('.') && PLURAL_CATEGORIES.some((category) => key === `${literal}.${category}`)) {
      return true;
    }
  }
  return false;
}

/**
 * What is wrong with a set of references, and nothing about the catalog as a whole.
 *
 * Split out because this is the half an editor can answer for one unsaved file. The key
 * under the cursor either resolves or it does not, while "no source names this entry" is
 * a question about every file in the application and belongs to a run of the check.
 *
 * @param {MessageModel} messages
 * @param {readonly MessageReference[]} references
 * @returns {Diagnostic[]}
 */
export function referenceFindings(messages, references) {
  /** @type {Diagnostic[]} */
  const found = [];
  const group = messages.app.name;
  // An application that registers no bundles has nothing for a key to be absent from.
  if (messages.bundles.length === 0) return found;

  for (const reference of references) {
    if (reference.key === null) continue;

    const resolved = resolveMessage(messages, reference);
    if (resolved === null) {
      found.push(
        error(
          'messages/unknown-key',
          `"${reference.key}" is in no bundle this file can reach. A message with no key renders ` +
            `as the key itself, in every language.${suggestion(messages, reference)}`,
          { group, file: reference.file, line: reference.line, column: reference.column },
        ),
      );
      continue;
    }

    found.push(...placeholderFindings(messages, reference, resolved.value));
  }

  return found;
}

/**
 * Every message one buffer names, read from the text rather than from the file.
 *
 * What the editor needs. A key is misspelled while it is being typed, and the file on
 * disk still holds the version that worked. The catalogs are the saved ones, which is
 * correct, because a bundle is not being edited in this buffer.
 *
 * @param {ProjectModel} model
 * @param {string} file
 * @param {string} source
 * @returns {Promise<MessageReference[]>}
 */
export async function sourceReferences(model, file, source) {
  if (!isAuthored(file, model.app)) return [];

  if (/\.m?js$/u.test(file)) {
    const parsed = parseSource(file, source, model.prefixes);
    return parsed.messages.map((reference) => ({ ...reference, file, form: 'javascript' }));
  }

  const read = await templateReferences(file, source);
  return read.references;
}

/**
 * The placeholders a pattern needs against the parameters a call passes.
 *
 * A pattern keeps an unfilled `{name}` verbatim, so the sentence reaches the page with a
 * brace in it. A parameter nothing interpolates is the other half of the same rename and
 * is reported as a warning, since a call may pass `count` for the plural rule alone.
 *
 * @param {MessageModel} messages
 * @param {MessageReference} reference
 * @param {string} pattern
 * @returns {Diagnostic[]}
 */
function placeholderFindings(messages, reference, pattern) {
  if (reference.params === null) return [];

  const group = messages.app.name;
  const where = { group, file: reference.file, line: reference.line, column: reference.column };
  const needed = [...pattern.matchAll(PLACEHOLDER)].map((match) => match[1] ?? '');
  const missing = needed.filter((name) => !reference.params?.includes(name));
  const extra = (reference.params ?? []).filter(
    (name) => name !== 'count' && !needed.includes(name),
  );

  /** @type {Diagnostic[]} */
  const found = [];

  if (missing.length > 0) {
    found.push(
      error(
        'messages/missing-parameter',
        `"${String(reference.key)}" interpolates ${missing.map((name) => `{${name}}`).join(', ')}, ` +
          `which this call does not pass. An unfilled placeholder is rendered as written.`,
        where,
      ),
    );
  }

  if (extra.length > 0) {
    found.push(
      warning(
        'messages/unused-parameter',
        `"${String(reference.key)}" is passed ${extra.join(', ')}, which its message does not ` +
          `interpolate in ${messages.bundles[0]?.defaultLocale ?? 'the default locale'}.`,
        where,
      ),
    );
  }

  return found;
}

/**
 * The nearest key a typo was probably meant to be, when there is one close enough to name.
 *
 * @param {MessageModel} messages
 * @param {MessageReference} reference
 * @returns {string}
 */
function suggestion(messages, reference) {
  const key = reference.key ?? '';
  /** @type {{ key: string, distance: number } | null} */
  let best = null;

  for (const bundle of bundlesFor(messages, reference.file)) {
    const catalog = bundle.locales.get(bundle.defaultLocale);
    for (const candidate of catalog?.keys.keys() ?? []) {
      const distance = editDistance(key, candidate);
      if (best === null || distance < best.distance) best = { key: candidate, distance };
    }
  }

  if (best === null || best.distance > Math.max(2, Math.floor(key.length / 5))) return '';
  return ` Did you mean "${best.key}"?`;
}

/**
 * Levenshtein distance, two rows at a time. Called once per unresolved reference against
 * every key in reach, which is a few hundred comparisons on the failure path only.
 *
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function editDistance(left, right) {
  let previous = Array.from({ length: right.length + 1 }, (unused, index) => index);

  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      const substitution = (previous[column - 1] ?? 0) + (left[row - 1] === right[column - 1] ? 0 : 1);
      current[column] = Math.min(substitution, (previous[column] ?? 0) + 1, (current[column - 1] ?? 0) + 1);
    }
    previous = current;
  }

  return previous[right.length] ?? right.length;
}

/**
 * Whether a key is one form of a plural family the default locale declares.
 *
 * Plural categories are per language: Arabic declares `zero`, `two`, `few` and `many` for
 * a key English needs only `one` and `other` for, and those are translations rather than
 * keys the default locale forgot.
 *
 * @param {string} key
 * @param {Map<string, unknown>} base
 * @returns {boolean}
 */
function isPluralVariant(key, base) {
  const match = /^(.*)\.(zero|one|two|few|many|other)$/u.exec(key);
  const stem = match?.[1];
  if (stem === undefined) return false;
  return [...base.keys()].some((candidate) => candidate === stem || candidate.startsWith(`${stem}.`));
}

/* ── Extraction ────────────────────────────────────────────────────────── */

/**
 * Every key a reference asks for that no bundle answers, grouped by the bundle that
 * should hold it.
 *
 * The nearest bundle owns it, so a reference inside a remote goes to the remote's own
 * copy and everything else to the application's. A key whose parent is already a
 * message, such as `orders.title.long` where `orders.title` is a sentence, is reported
 * rather than written, because one of the two has to lose and neither choice is this
 * tool's.
 *
 * @param {MessageModel} messages
 * @returns {Array<{ bundle: MessageBundle, keys: string[], conflicts: string[] }>}
 */
export function missingMessages(messages) {
  /** @type {Map<MessageBundle, { keys: Set<string>, conflicts: Set<string> }>} */
  const wanted = new Map();

  for (const reference of messages.references) {
    if (reference.key === null || resolveMessage(messages, reference) !== null) continue;
    const [bundle] = bundlesFor(messages, reference.file);
    const catalog = bundle?.locales.get(bundle.defaultLocale);
    if (bundle === undefined || catalog === undefined) continue;

    const entry = wanted.get(bundle) ?? { keys: new Set(), conflicts: new Set() };
    if (occupiedAncestor(catalog, reference.key) === null) entry.keys.add(reference.key);
    else entry.conflicts.add(reference.key);
    wanted.set(bundle, entry);
  }

  return [...wanted].map(([bundle, entry]) => ({
    bundle,
    keys: [...entry.keys].sort(),
    conflicts: [...entry.conflicts].sort(),
  }));
}

/**
 * Write the missing keys into each default-locale bundle, and return what was added.
 *
 * An insertion rather than a rewrite. The entry goes inside the object that already
 * holds its siblings, and every byte a translator or a reviewer put in the file stays
 * where it was, including the ordering, the blank lines between sections and the
 * `$comment` notes. Running this twice adds nothing the second time.
 *
 * The value is the key itself, which is what the page already shows. That is
 * deliberate, because an empty string is a message that renders nothing and a missing
 * sentence should look missing until somebody writes it.
 *
 * @param {MessageModel} messages
 * @returns {Promise<Array<{ path: string, added: string[] }>>}
 */
export async function writeMissingMessages(messages) {
  /** @type {Array<{ path: string, added: string[] }>} */
  const written = [];

  for (const { bundle, keys } of missingMessages(messages)) {
    const catalog = bundle.locales.get(bundle.defaultLocale);
    if (catalog === undefined || keys.length === 0) continue;

    let text = catalog.text;
    const edits = [...insertions(catalog, keys)].sort(([left], [right]) => right - left);
    for (const [at, addition] of edits) {
      text = `${text.slice(0, at)}${addition}${text.slice(at)}`;
    }

    await writeFile(catalog.path, text, 'utf8');
    written.push({ path: catalog.path, added: keys });
  }

  return written;
}

/**
 * The message that stands where a key's parent object would have to go, or null when the
 * path is free.
 *
 * @param {MessageCatalog} catalog
 * @param {string} key
 * @returns {string | null}
 */
function occupiedAncestor(catalog, key) {
  const parts = key.split('.');
  for (let depth = 1; depth < parts.length; depth += 1) {
    const ancestor = parts.slice(0, depth).join('.');
    if (catalog.keys.has(ancestor)) return ancestor;
  }
  return null;
}

/**
 * Where each new entry goes and what it says, as offset-to-text edits against the file as
 * it stands.
 *
 * Keys are grouped by the deepest object that already exists, so `orders.newThing` joins
 * `orders` and two keys under one new parent produce one parent rather than two entries
 * with the same name.
 *
 * @param {MessageCatalog} catalog
 * @param {string[]} keys
 * @returns {Map<number, string>}
 */
function insertions(catalog, keys) {
  /** @type {Map<string, Record<string, any>>} */
  const groups = new Map();

  for (const key of keys) {
    const parts = key.split('.');
    let ancestor = '';
    for (let depth = parts.length - 1; depth >= 1; depth -= 1) {
      const candidate = parts.slice(0, depth).join('.');
      if (catalog.objects.has(candidate)) {
        ancestor = candidate;
        break;
      }
    }

    const tree = groups.get(ancestor) ?? {};
    const remainder = ancestor === '' ? parts : parts.slice(ancestor.split('.').length);
    let branch = tree;
    for (const [index, part] of remainder.entries()) {
      if (index === remainder.length - 1) branch[part] = key;
      else {
        branch[part] = typeof branch[part] === 'object' ? branch[part] : {};
        branch = branch[part];
      }
    }
    groups.set(ancestor, tree);
  }

  /** @type {Map<number, string>} */
  const edits = new Map();

  for (const [ancestor, tree] of groups) {
    const object = catalog.objects.get(ancestor);
    if (object === undefined) continue;

    // Indented like its siblings and inserted directly after the last entry, because
    // the newline and the indentation before the closing brace are already in the
    // file.
    const line = catalog.text.lastIndexOf('\n', object.end);
    const closing = /^[ \t]*/u.exec(catalog.text.slice(line + 1))?.[0] ?? '';
    const indent = `${closing}  `;
    const comma = object.entries > 0 ? ',' : '';

    edits.set(
      lastEntryEnd(catalog.text, object.end),
      `${comma}\n${indent}${entries(tree, indent)}`,
    );
  }

  return edits;
}

/**
 * One level of new entries, indented like its siblings.
 *
 * @param {Record<string, any>} tree
 * @param {string} indent
 * @returns {string}
 */
function entries(tree, indent) {
  return Object.entries(tree)
    .map(([name, value]) =>
      typeof value === 'string'
        ? `${JSON.stringify(name)}: ${JSON.stringify(value)}`
        : `${JSON.stringify(name)}: {\n${indent}  ${entries(value, `${indent}  `)}\n${indent}}`,
    )
    .join(`,\n${indent}`);
}

/**
 * The offset just after an object's last entry, which is where a comma has to go.
 *
 * @param {string} text
 * @param {number} close Offset of the closing brace.
 * @returns {number}
 */
function lastEntryEnd(text, close) {
  let at = close;
  while (at > 0 && /\s/u.test(text[at - 1] ?? '')) at -= 1;
  return at;
}
