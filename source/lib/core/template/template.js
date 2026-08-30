/**
 * Templates in their own `.html` files, compiled at runtime.
 *
 * A component is a `.js` and a sibling `.html`, and the markup is ordinary HTML
 * with ordinary HTML tooling. `@core/elements/component.js` derives the template
 * URL from the module rather than having every component write it down.
 *
 * WHY IT IS NOT SLOW, AND THE INVARIANT THAT KEEPS IT THAT WAY
 *
 * Each `.html` file is fetched once, walked once, and emitted as exactly one
 * strings array plus one compiled evaluator per binding. The compiled result is
 * cached per URL and must never be rebuilt: lit keys its parsed template on the
 * *identity* of that array, so a byte-identical replacement rebuilds the DOM
 * instead of patching it. ADR-0014.
 *
 * Bindings are a restricted expression language over a component's *public*
 * members — see expression.js — and each template costs one request of its own.
 * `prefetchTemplates` starts those requests together from a list the build knows;
 * `seedTemplates` removes them entirely, when a bundle is configured.
 */

import { html, nothing } from 'lit';
import { AsyncDirective, directive } from 'lit/async-directive.js';
import { repeat } from 'lit/directives/repeat.js';
import { compileExpression } from '@core/template/expression.js';
import {
  classifyAttributeName,
  classifyBindingTarget,
  FOR_HEAD,
  FOR_INDEX_CLAUSE,
  FOR_KEY_CLAUSE,
  INTERPOLATION,
  VOID_ELEMENTS,
} from '@core/template/dialect.js';
import { effect } from '@core/foundation/reactive.js';
import {
  sanitizeAttribute,
  sanitizeProperty,
} from '@core/template/security.js';

// Side effect only: i18n registers `t`, `num`, `dt` and friends as template
// globals. Imported here rather than left to the application, so that every
// template can be translated whether or not anything else pulled i18n in.
import '@core/localization/i18n.js';

/** @import { CompiledTemplate, Evaluator, Scope, TemplateChunks, TemplateLocals } from '@core/template/types.js' */

/**
 * The runtime-loaded component template is framework-owned source, not a bound
 * application value. Its identity policy is private to this module so it cannot
 * become an unreviewed application escape hatch.
 *
 * @typedef {{ createHTML(value: string): unknown }} TemplatePolicy
 * @typedef {{ createPolicy(name: string, rules: { createHTML(value: string): string }): TemplatePolicy }} TemplatePolicyFactory
 */
const templatePolicyFactory = /** @type {{ trustedTypes?: TemplatePolicyFactory }} */ (
  /** @type {unknown} */ (globalThis)
).trustedTypes;
const templatePolicy = templatePolicyFactory?.createPolicy('ui-test-template', {
  createHTML: (value) => value,
});

/** @param {HTMLTemplateElement} template @param {string} source */
function setTemplateSource(template, source) {
  template.innerHTML = /** @type {string} */ (
    /** @type {unknown} */ (templatePolicy?.createHTML(source) ?? source)
  );
}

/* ── Registry ──────────────────────────────────────────────────────────── */

/** @type {Map<string, Promise<CompiledTemplate>>} */
const byUrl = new Map();

/** @type {Map<string, string>} */
const sourceByUrl = new Map();

/** @type {WeakMap<object, CompiledTemplate>} */
const byClass = new WeakMap();

/**
 * Load and compile a template, once per URL.
 *
 * The promise is cached rather than the result, so two components mounting at the
 * same moment share one request instead of racing two.
 *
 * @param {string | URL} url
 * @returns {Promise<CompiledTemplate>}
 */
export function loadTemplate(url) {
  const href = new URL(url, document.baseURI).href;

  let pending = byUrl.get(href);
  if (pending === undefined) {
    pending = fetchAndCompile(href);
    byUrl.set(href, pending);
  }
  return pending;
}

/**
 * Start a list of templates arriving, without waiting for any of them.
 *
 * The list is the one thing this cannot work out for itself. A component names its
 * own template, so a URL is known only once that component's module has been
 * fetched and evaluated — and nine components concatenated into one chunk means
 * nine requests in a row inside a single file, because each `await attachTemplate`
 * sits in a module body and module bodies run in sequence. The build holds all nine
 * URLs before the chunk exists. Handed them, this puts them in flight at once, and
 * every `await` that follows resolves from the cache above. ADR-0081.
 *
 * Idempotent and safe to call with URLs nothing will ever ask for: `loadTemplate`
 * caches the promise, so a duplicate is not a second request, and a component that
 * is never mounted has simply had its markup fetched early.
 *
 * A rejection is swallowed here on purpose. This is an optimisation, and the
 * component that actually needs the template awaits the same promise through
 * `attachTemplate` — which is where the failure belongs: raised once, at the point
 * that genuinely cannot continue, rather than a second time as an unhandled
 * rejection for a route nobody opened.
 *
 * @param {Iterable<string | URL>} urls
 * @returns {void}
 */
export function prefetchTemplates(urls) {
  for (const url of urls) {
    // Attaching the handler to the cached promise rather than to a copy: this is
    // what marks *that* promise handled, so a template that 404s stays a quiet
    // prefetch until someone awaits it.
    loadTemplate(url).catch(() => {});
  }
}

/**
 * @param {string} href
 * @returns {Promise<CompiledTemplate>}
 */
async function fetchAndCompile(href) {
  const seeded = sourceByUrl.get(href);
  if (seeded !== undefined) return compileTemplate(seeded, href);

  const response = await fetch(href);
  if (!response.ok) {
    throw new Error(
      `Cannot load template ${href}: ${String(response.status)} ${response.statusText}`,
    );
  }
  return compileTemplate(await response.text(), href);
}

/**
 * Seed the cache from a pre-bundled `{ url: source }` map, so no template costs
 * a request of its own.
 *
 * Deliberately a seed rather than a replacement: the compile path is identical
 * either way, which means development and production run the same compiler over
 * the same bytes and a bundling bug cannot change rendering behaviour.
 *
 * @param {Readonly<Record<string, string>>} sources Keys are URLs, absolute or
 *   root-relative.
 */
export function seedTemplates(sources) {
  for (const [url, source] of Object.entries(sources)) {
    sourceByUrl.set(new URL(url, document.baseURI).href, source);
  }
}

/**
 * Compile a template and make it the one a class renders.
 *
 * Called only by `defineComponent` in `@core/elements/component.js`, which owns the order:
 * a template is attached before `customElements.define`, because defining first
 * would upgrade elements already in the document and Lit renders on connection,
 * so the first paint would be empty markup. This module owns compilation; which
 * class a compiled template belongs to is identity, and identity lives there.
 *
 * @param {object} ctor
 * @param {string | URL} url
 * @returns {Promise<void>}
 */
export async function attachTemplate(ctor, url) {
  byClass.set(ctor, await loadTemplate(url));
}

/**
 * The compiled template registered for a class, if any. Read by
 * `SignalElement.render`.
 *
 * @param {object} ctor
 * @returns {CompiledTemplate | undefined}
 */
export function templateFor(ctor) {
  // Walks the chain so a component subclassed to tweak behaviour inherits its
  // parent's template instead of failing with "no template", which is otherwise
  // a genuinely confusing first encounter with class inheritance here.
  /** @type {object | null} */
  let current = ctor;
  while (current !== null) {
    const found = byClass.get(current);
    if (found !== undefined) return found;
    // `Reflect.getPrototypeOf` rather than `Object.getPrototypeOf`: the former is
    // declared to return `object | null`, the latter `any`, and an `any` here
    // would spread into the return type.
    current = Reflect.getPrototypeOf(current);
  }
  return undefined;
}

/* ── Interpolation pre-pass ────────────────────────────────────────────── */

/**
 * `{{ ... }}` bodies are lifted out before the HTML parser sees the source, and
 * replaced with `⟦n⟧` placeholders.
 *
 * Not an optimisation. `{{ a < b }}` in text content would otherwise be parsed as
 * the start of a tag named `b`, and the expression would be silently mangled into
 * markup. Lifting the bodies first means the parser only ever sees inert text,
 * and every expression survives byte for byte.
 */
const PLACEHOLDER = /⟦(\d+)⟧/u;
const PLACEHOLDER_ALL = /⟦(\d+)⟧/gu;

/**
 * @param {string} source
 * @returns {{ prepared: string, expressions: string[] }}
 */
function liftInterpolations(source) {
  /** @type {string[]} */
  const expressions = [];
  const prepared = source.replace(INTERPOLATION, (_all, body) => {
    expressions.push(typeof body === 'string' ? body : '');
    return `⟦${String(expressions.length - 1)}⟧`;
  });
  return { prepared, expressions };
}

/* ── Chunk accumulation ────────────────────────────────────────────────── */

/**
 * Accumulates the static strings and the binding evaluators that together become
 * one lit template.
 *
 * The strings array is built once and frozen into the shape lit expects, then
 * handed to `html()` on every render. Its identity is the cache key inside
 * lit-html, so it must never be rebuilt.
 */
class Chunks {
  /** @type {string[]} */
  #parts = [];
  #current = '';
  /** @type {Evaluator[]} */
  #values = [];

  /** @param {string} text */
  text(text) {
    this.#current += text;
  }

  /** @param {Evaluator} evaluator */
  hole(evaluator) {
    this.#parts.push(this.#current);
    this.#current = '';
    this.#values.push(evaluator);
  }

  /** @returns {TemplateChunks} */
  finish() {
    this.#parts.push(this.#current);

    const strings = /** @type {string[] & { raw?: readonly string[] }} */ ([...this.#parts]);
    // lit reads `strings.raw`, which a hand-built array does not have. Not
    // enumerable, so the array still looks like a plain string array everywhere
    // else.
    Object.defineProperty(strings, 'raw', { value: Object.freeze([...this.#parts]) });

    return {
      strings: /** @type {TemplateStringsArray} */ (/** @type {unknown} */ (strings)),
      values: this.#values,
    };
  }
}

/**
 * Give every compiled binding its own signal dependency set and Lit update path,
 * so a signal changing in one interpolation updates that one Part instead of
 * re-rendering the whole template.
 *
 * Three things make a binding re-evaluate:
 *
 *  1. A signal it reads changed. The effect re-runs, writes with `setValue`, and
 *     Lit commits this Part and nothing else.
 *  2. The host rendered, so an ordinary Lit property it reads may have changed.
 *     Lit properties are not signals, so the binding is evaluated again inside a
 *     fresh effect: a template that branches reads different signals in each
 *     branch, and a dependency set captured once would go stale.
 *  3. Its `*for` row was given a different item or index.
 *
 * Anything else must cost nothing, which is what `scope.version` is for: the
 * scope keeps its identity for the life of its host or its row, and this
 * directive short-circuits on that identity. ADR-0018.
 */
class ReactiveBindingDirective extends AsyncDirective {
  /** @type {Evaluator | undefined} */
  #evaluate;

  /** @type {Scope | undefined} */
  #scope;

  /** The `scope.version` this binding's `#value` was evaluated at. */
  #version = -1;

  /** @type {unknown} */
  #value;

  /** @type {(() => void) | undefined} */
  #dispose;

  /**
   * @param {Evaluator} evaluate
   * @param {Scope} scope
   * @returns {unknown}
   */
  render(evaluate, scope) {
    return this.#track(evaluate, scope, false);
  }

  /**
   * @param {unknown} _part
   * @param {[Evaluator, Scope]} values
   * @returns {unknown}
   */
  update(_part, [evaluate, scope]) {
    if (evaluate === this.#evaluate && scope === this.#scope && scope.version === this.#version) {
      return this.#value;
    }
    return this.#track(evaluate, scope, false);
  }

  disconnected() {
    this.#dispose?.();
    this.#dispose = undefined;
  }

  reconnected() {
    if (this.#evaluate !== undefined && this.#scope !== undefined) {
      this.#track(this.#evaluate, this.#scope, true);
    }
  }

  /**
   * @param {Evaluator} evaluate
   * @param {Scope} scope
   * @param {boolean} commitInitial
   * @returns {unknown}
   */
  #track(evaluate, scope, commitInitial) {
    this.#dispose?.();
    this.#dispose = undefined;
    this.#evaluate = evaluate;
    this.#scope = scope;
    this.#version = scope.version;

    if (!this.isConnected) {
      this.#value = evaluate(scope);
      return this.#value;
    }

    let initial = true;
    this.#dispose = effect(() => {
      this.#value = evaluate(scope);
      if (!initial || commitInitial) this.setValue(this.#value);
      initial = false;
    });
    return this.#value;
  }
}

const reactiveBinding = directive(ReactiveBindingDirective);

/**
 * @param {TemplateChunks} chunks
 * @param {Scope} scope
 * @returns {unknown}
 */
function renderChunks(chunks, scope) {
  const values = chunks.values.map((value) => reactiveBinding(value, scope));
  return html(chunks.strings, ...values);
}

/* ── Compiler ──────────────────────────────────────────────────────────── */

/**
 * Compile template source into a render function.
 *
 * Exported for tests; application code goes through `loadTemplate`.
 *
 * @param {string} source
 * @param {string} where URL or label used in error messages.
 * @returns {CompiledTemplate}
 * @internal
 */
export function compileTemplate(source, where) {
  const { prepared, expressions } = liftInterpolations(source);

  const holder = document.createElement('template');
  setTemplateSource(holder, prepared);

  /** @type {CompileContext} */
  const context = { where, expressions };
  const chunks = new Chunks();
  compileNodes([...holder.content.childNodes], context, chunks);
  const compiled = chunks.finish();

  /**
   * One scope per host, for the life of the host.
   *
   * The binding directive short-circuits on scope *identity*, so a fresh object
   * per render would make every binding throw away its effect and build another.
   * Bumping a version says the same thing — "the host rendered, re-read what you
   * read" — without allocating, and without making a `*for` row look new.
   *
   * @type {WeakMap<object, Scope>}
   */
  const byHost = new WeakMap();

  return (host) => {
    const existing = byHost.get(host);
    if (existing !== undefined) {
      // A Lit render. Ordinary reactive properties are not signals, so nothing
      // can be assumed about what they now hold.
      existing.version += 1;
      return renderChunks(compiled, existing);
    }

    /** @type {Scope} */
    const scope = {
      host: /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (host)),
      locals: EMPTY_LOCALS,
      version: 0,
    };
    byHost.set(host, scope);
    return renderChunks(compiled, scope);
  };
}

/**
 * Shared, never written to. A component with no `*for` and no event binding above
 * it needs no locals at all.
 *
 * Row locals are prototype-chained with `Object.create`, so a nested `*for` sees
 * the outer loop's variables through the chain and a row's locals can be updated
 * in place. That only works if the chain ends in `null`: a chain reaching
 * `Object.prototype` would resolve `{{ toString }}` to an inherited function.
 * `expression.js` keeps a denylist for host lookups, and this is the locals half
 * of the same rule.
 *
 * @type {TemplateLocals}
 */
const EMPTY_LOCALS = Object.freeze(childLocals(null));

/**
 * A locals object chained to `parent`, or the root of a chain when given `null`.
 *
 * A named helper because `Object.create` is typed `any`, and an `any` spreading
 * into every row's locals would quietly disable type checking around the one
 * object templates read the most.
 *
 * @param {TemplateLocals | null} parent
 * @returns {TemplateLocals}
 */
function childLocals(parent) {
  /** @type {unknown} */
  const created = Object.create(parent);
  return /** @type {TemplateLocals} */ (created);
}

/**
 * @typedef {object} CompileContext
 * @property {string} where
 * @property {string[]} expressions
 */

/**
 * One `*for` row's held scope, plus the parent version it was last refreshed
 * against.
 *
 * @typedef {{ scope: Scope, parentVersion: number }} Row
 */

/**
 * @param {Node[]} nodes
 * @param {CompileContext} context
 * @param {Chunks} chunks
 */
function compileNodes(nodes, context, chunks) {
  /** @type {Set<Node>} */
  const consumed = new Set();

  for (const node of nodes) {
    if (consumed.has(node)) continue;

    if (node.nodeType === Node.TEXT_NODE) {
      compileText(node.textContent ?? '', context, chunks);
      continue;
    }
    if (node.nodeType === Node.COMMENT_NODE) continue;
    if (!(node instanceof Element)) continue;

    compileElement(node, context, chunks, consumed);
  }
}

/**
 * @param {string} text
 * @param {CompileContext} context
 * @param {Chunks} chunks
 */
function compileText(text, context, chunks) {
  for (const piece of splitPlaceholders(text)) {
    if (typeof piece === 'string') chunks.text(escapeText(piece));
    else chunks.hole(expressionAt(piece, context, false));
  }
}

/**
 * @param {Element} element
 * @param {CompileContext} context
 * @param {Chunks} chunks
 * @param {Set<Node>} consumed
 */
function compileElement(element, context, chunks, consumed) {
  const tag = element.localName;

  if (tag === 'script') {
    throw new Error(
      `${context.where} contains a <script> element. Templates are markup only; ` +
        `put behaviour in the component's .js file.`,
    );
  }

  const structuralFor = element.getAttribute('*for');
  const structuralIf = element.getAttribute('*if');

  if (structuralFor !== null && structuralIf !== null) {
    throw new Error(
      `<${tag}> in ${context.where} carries both *for and *if. Wrap one in an ` +
        `element of its own, so which applies first is written down rather than guessed.`,
    );
  }

  if (structuralFor !== null) {
    element.removeAttribute('*for');
    chunks.hole(compileFor(element, structuralFor, context));
    return;
  }

  if (structuralIf !== null) {
    element.removeAttribute('*if');
    chunks.hole(compileIf(element, structuralIf, context, consumed));
    return;
  }

  if (element.hasAttribute('*else')) {
    throw new Error(
      `<${tag}> in ${context.where} has *else but the element before it has no *if.`,
    );
  }

  chunks.text(`<${tag}`);
  compileAttributes(element, context, chunks);
  chunks.text('>');

  if (!VOID_ELEMENTS.has(tag)) {
    compileNodes([...element.childNodes], context, chunks);
    chunks.text(`</${tag}>`);
  }
}

/**
 * @param {Element} element
 * @param {CompileContext} context
 * @param {Chunks} chunks
 */
function compileAttributes(element, context, chunks) {
  for (const attribute of [...element.attributes]) {
    const { name, value } = attribute;

    if (name === '*else') continue;

    const syntax = classifyAttributeName(name);

    if (syntax.kind === 'inline-handler') {
      throw new Error(
        `<${element.localName} ${name}> in ${context.where}: inline event handler ` +
          `attributes are not supported. Use (${syntax.event})="handler()".`,
      );
    }

    if (syntax.kind === 'event') {
      const { event } = syntax;
      const handler = compileExpression(value, `${context.where} (${event})`, {
        allowAssignment: true,
      });
      chunks.text(` @${event}=`);
      chunks.hole(
        (scope) =>
          /** @param {Event} domEvent */
          (domEvent) => {
            // `Object.create` rather than a spread: locals are chained, so a
            // spread would copy the row's own variables and lose every one it
            // inherits from an enclosing `*for`.
            const locals = childLocals(scope.locals);
            locals.$event = domEvent;
            handler({ host: scope.host, locals, version: scope.version });
          },
      );
      continue;
    }

    if (syntax.kind === 'binding') {
      compileBinding(element, syntax.target, value, context, chunks);
      continue;
    }

    // Plain attribute. Its value may still interpolate, which is how a static
    // Tailwind class list and a conditional one live in the same attribute:
    //   class="rounded border {{ active ? 'bg-sky-50' : 'bg-white' }}"
    const pieces = splitPlaceholders(value);
    if (pieces.length === 1 && typeof pieces[0] === 'string') {
      chunks.text(value === '' ? ` ${name}` : ` ${name}="${escapeAttribute(value)}"`);
      continue;
    }

    const evaluate = compileInterpolatedAttribute(pieces, context);
    const where = `${context.where} ${name} interpolation`;
    chunks.text(` ${name}="`);
    chunks.hole((scope) =>
      sanitizeOrNothing(sanitizeAttribute(element.localName, name, evaluate(scope), where)),
    );
    chunks.text('"');
  }
}

/**
 * @param {Element} element
 * @param {string} target Inside of the brackets: `href`, `?disabled`, `.limit`.
 * @param {string} source
 * @param {CompileContext} context
 * @param {Chunks} chunks
 */
function compileBinding(element, target, source, context, chunks) {
  const where = `${context.where} [${target}]`;
  const classified = classifyBindingTarget(target);
  const { name } = classified;

  switch (classified.kind) {
    case 'inline-handler':
      throw new Error(
        `<${element.localName}> in ${context.where} binds inline event attribute ${target}. ` +
          `Use (${target.slice(2)})="handler()".`,
      );
    case 'empty-property':
      throw new Error(`<${element.localName}> in ${context.where} has an empty property binding.`);
    case 'empty-attribute':
      throw new Error(`<${element.localName}> in ${context.where} has an empty [] binding.`);
    default:
      break;
  }

  const evaluate = compileExpression(source, where);

  if (classified.kind === 'property') {
    // Reject dangerous property targets while compiling, even if this render
    // never happens. Other contexts sanitize on every evaluation below.
    sanitizeProperty(element.localName, name, null, where);
    chunks.text(` .${name}=`);
    chunks.hole((scope) =>
      sanitizeOrNothing(sanitizeProperty(element.localName, name, evaluate(scope), where)),
    );
    return;
  }

  if (classified.kind === 'boolean') {
    chunks.text(` ?${name}=`);
    chunks.hole(evaluate);
    return;
  }

  chunks.text(` ${name}="`);
  chunks.hole((scope) =>
    sanitizeOrNothing(sanitizeAttribute(element.localName, name, evaluate(scope), where)),
  );
  chunks.text('"');
}

/**
 * @param {Element} element
 * @param {string} source
 * @param {CompileContext} context
 * @param {Set<Node>} consumed
 * @returns {Evaluator}
 */
function compileIf(element, source, context, consumed) {
  const test = compileExpression(source, `${context.where} *if`);
  const branch = compileSubtree(element, context);

  /** @type {TemplateChunks | undefined} */
  let alternate;
  const next = nextElement(element);
  if (next?.hasAttribute('*else') === true) {
    next.removeAttribute('*else');
    consumed.add(next);
    // Whitespace between the two elements is consumed with the `*else` branch,
    // or it would render as a stray text node whichever branch is showing.
    for (const between of nodesBetween(element, next)) consumed.add(between);
    alternate = compileSubtree(next, context);
  }

  return (scope) => {
    if (test(scope)) return renderChunks(branch, scope);
    return alternate === undefined ? nothing : renderChunks(alternate, scope);
  };
}

/**
 * `*for="user of users"`, with two optional clauses. The syntax itself lives in
 * dialect.js; `key` is not optional in spirit — without it a reorder re-renders
 * every row's bindings, with it lit-html moves the existing DOM. `$index`,
 * `$first`, `$last` and `$count` are always in scope.
 *
 * @param {Element} element
 * @param {string} source
 * @param {CompileContext} context
 * @returns {Evaluator}
 */
function compileFor(element, source, context) {
  const where = `${context.where} *for`;
  const [head = '', ...clauses] = source.split(';');

  const parsed = FOR_HEAD.exec(head);
  if (parsed === null) {
    throw new Error(
      `Cannot read *for="${source}" in ${context.where}. ` +
        `Expected *for="item of items", optionally followed by "; key: expr" or "; index as name".`,
    );
  }
  const [, alias = '', listSource = ''] = parsed;

  /** @type {Evaluator | undefined} */
  let key;
  let indexAlias = '$index';

  for (const clause of clauses) {
    const trimmed = clause.trim();
    if (trimmed === '') continue;

    const keyed = FOR_KEY_CLAUSE.exec(trimmed);
    if (keyed?.[1] !== undefined) {
      key = compileExpression(keyed[1], `${where} key`);
      continue;
    }
    const indexed = FOR_INDEX_CLAUSE.exec(trimmed);
    if (indexed?.[1] !== undefined) {
      indexAlias = indexed[1];
      continue;
    }
    throw new Error(`Cannot read *for clause "${trimmed}" in ${context.where}.`);
  }

  const list = compileExpression(listSource, `${where} list`);
  const row = compileSubtree(element, context);

  /**
   * Row scopes, per enclosing scope, held across evaluations by position.
   *
   * Keyed by the parent scope because one compiled `*for` serves every instance
   * of the component and every row of an enclosing loop, and the parent scope is
   * now exactly the identity that distinguishes them. Positional rather than
   * keyed by the `key` expression, because the key is evaluated *against* a row
   * scope and cannot be known before one exists.
   *
   * @type {WeakMap<Scope, Row[]>}
   */
  const byParent = new WeakMap();

  return (scope) => {
    const items = toArray(list(scope));
    const count = items.length;

    let rows = byParent.get(scope);
    if (rows === undefined) {
      rows = [];
      byParent.set(scope, rows);
    }

    /** @type {Scope[]} */
    const scopes = [];
    for (let index = 0; index < count; index += 1) {
      const item = items[index];
      let entry = rows[index];
      if (entry === undefined) {
        entry = {
          scope: { host: scope.host, locals: childLocals(scope.locals), version: 0 },
          parentVersion: -1,
        };
        rows[index] = entry;
      }

      const { locals } = entry.scope;
      // The row's own version only moves when something it can see moved: its
      // item, its position, the length of the list, or the host itself. A row
      // that survives a re-render unchanged costs one comparison, not eight
      // effect rebuilds.
      if (
        entry.parentVersion !== scope.version ||
        locals[alias] !== item ||
        locals.$index !== index ||
        locals.$count !== count
      ) {
        locals[alias] = item;
        if (indexAlias !== '$index') locals[indexAlias] = index;
        locals.$index = index;
        locals.$first = index === 0;
        locals.$last = index === count - 1;
        locals.$count = count;
        entry.parentVersion = scope.version;
        entry.scope.version += 1;
      }
      scopes.push(entry.scope);
    }
    // Rows that no longer exist keep no scope, so a list that shrinks and grows
    // again does not hand a new row the previous occupant's locals.
    rows.length = count;

    if (key === undefined) return scopes.map((child) => renderChunks(row, child));

    const keyOf = key;
    return repeat(
      scopes,
      (child) => keyOf(child),
      (child) => renderChunks(row, child),
    );
  };
}

/**
 * Compile one element as a template of its own. Used by the structural
 * directives, whose bodies must be separate lit templates so that lit can insert
 * and remove them as units.
 *
 * @param {Element} element
 * @param {CompileContext} context
 * @returns {TemplateChunks}
 */
function compileSubtree(element, context) {
  const chunks = new Chunks();
  compileElement(element, context, chunks, new Set());
  return chunks.finish();
}

/* ── Small helpers ─────────────────────────────────────────────────────── */

/**
 * @param {string} text
 * @returns {(string | number)[]}
 */
function splitPlaceholders(text) {
  if (!PLACEHOLDER.test(text)) return [text];

  /** @type {(string | number)[]} */
  const pieces = [];
  let last = 0;
  PLACEHOLDER_ALL.lastIndex = 0;

  for (const match of text.matchAll(PLACEHOLDER_ALL)) {
    if (match.index > last) pieces.push(text.slice(last, match.index));
    pieces.push(Number(match[1]));
    last = match.index + match[0].length;
  }
  if (last < text.length) pieces.push(text.slice(last));
  return pieces;
}

/**
 * @param {number} index
 * @param {CompileContext} context
 * @param {boolean} allowAssignment
 * @returns {Evaluator}
 */
function expressionAt(index, context, allowAssignment) {
  const source = context.expressions[index];
  if (source === undefined) throw new Error(`Lost interpolation ${String(index)} in ${context.where}.`);
  return compileExpression(source, `${context.where} {{ ${source.trim()} }}`, { allowAssignment });
}

/**
 * Compile a plain attribute containing one or more `{{ }}` expressions into one
 * value. Keeping it as one Lit part lets TrustedHTML reach sinks such as srcdoc
 * without being stringified by interpolation concatenation.
 *
 * @param {(string | number)[]} pieces
 * @param {CompileContext} context
 * @returns {Evaluator}
 */
function compileInterpolatedAttribute(pieces, context) {
  const compiled = pieces.map((piece) =>
    typeof piece === 'string' ? piece : expressionAt(piece, context, false),
  );
  if (compiled.length === 1 && typeof compiled[0] === 'function') return compiled[0];

  return (scope) =>
    compiled
      // Preserve Lit's existing interpolation coercion for non-security
      // attributes; objects intentionally render with their JavaScript string.
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      .map((piece) => (typeof piece === 'string' ? piece : String(piece(scope) ?? '')))
      .join('');
}

/** @param {unknown | null} value @returns {unknown} */
function sanitizeOrNothing(value) {
  return value === null ? nothing : value;
}

/**
 * @param {unknown} value
 * @returns {unknown[]}
 */
function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  if (typeof value === 'object' && Symbol.iterator in value) {
    return [...(/** @type {Iterable<unknown>} */ (value))];
  }
  // Not iterable: an empty list. `npm run templates:check` types the expression
  // against the component, which is where a non-iterable `*for` is caught.
  return [];
}

/**
 * @param {Element} element
 * @returns {Element | null}
 */
function nextElement(element) {
  return element.nextElementSibling;
}

/**
 * @param {Element} start
 * @param {Element} end
 * @returns {Node[]}
 */
function nodesBetween(start, end) {
  /** @type {Node[]} */
  const between = [];
  let node = start.nextSibling;
  while (node !== null && node !== end) {
    between.push(node);
    node = node.nextSibling;
  }
  return between;
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapeText(text) {
  return text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapeAttribute(text) {
  return text.replace(/&/gu, '&amp;').replace(/"/gu, '&quot;');
}
