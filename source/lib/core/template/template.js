/**
 * Compiles `.html` templates at runtime.
 *
 * Each `.html` file is fetched once, walked once and compiled to one strings array
 * plus one evaluator per binding. The result is cached per URL and never rebuilt,
 * because lit keys its parsed template on the array's identity. ADR-0014.
 *
 * Bindings use a restricted expression language over a component's public members
 * (see expression.js). `prefetchTemplates` starts template requests early without
 * compiling, and `seedTemplates` fills the cache from a bundle.
 *
 * `registerTemplateGroups` records which templates travel together. Startup starts
 * the entry group, and every other group starts on the first `attachTemplate` from
 * its chunk. ADR-0081.
 */

import { html, nothing } from 'lit';
// `Directive` and `AsyncDirective` both come from lit's async-directive module.
import { AsyncDirective, Directive, directive } from 'lit/async-directive.js';
import { repeat } from 'lit/directives/repeat.js';
import { compileExpression } from '@core/template/expression.js';
import {
  classifyAttributeName,
  classifyBindingTarget,
  FOR_HEAD,
  FOR_INDEX_CLAUSE,
  FOR_KEY_CLAUSE,
  INTERPOLATION,
  parseFragmentHead,
  refusedProperty,
  securityContextFor,
  VOID_ELEMENTS,
} from '@core/template/dialect.js';
import { effect } from '@core/foundation/reactive.js';
import { beginBindingUpdate, labelBinding } from '@core/diagnostics/updates.js';
import { OWNER_ATTRIBUTE } from '@core/elements/style-scope.js';
import {
  attributeSinkFor,
  propertySinkFor,
} from '@core/template/security.js';

// i18n registers `t`, `num`, `dt` and the other template globals, so every template
// can translate.
import '@core/localization/i18n.js';

/** @import { BindingUpdateCause } from '@core/diagnostics/types.js' */
/** @import { CompiledTemplate, Evaluator, Scope, TemplateChunks, TemplateFragment, TemplateLocals } from '@core/template/types.js' */

/**
 * A Trusted Types policy for framework-owned template source. It stays private to
 * this module, so application code can't use it to bypass sanitization.
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

/**
 * Compiled templates by URL.
 *
 * Fetching and compiling are cached separately. `sourceByUrl` holds bytes, which
 * `prefetchTemplates` may start early. `byUrl` holds compiles, which happen in
 * `attachTemplate` once per component that mounts. Merging the two would compile
 * every prefetched template before the first paint.
 *
 * A source entry is a string when seeded from a bundle and a promise when fetched,
 * so a prefetch and the `attachTemplate` after it share one request.
 *
 * @type {Map<string, Promise<CompiledTemplate>>}
 */
const byUrl = new Map();

/** @type {Map<string, string | Promise<string>>} */
const sourceByUrl = new Map();

/** @type {WeakMap<object, CompiledTemplate>} */
const byClass = new WeakMap();

/**
 * Classes that attached each URL, so a development revision can update them all.
 *
 * @type {Map<string, Set<object>>}
 */
const attachedByUrl = new Map();

/**
 * The owner tag each template's compile stamps, or null when unstyled. It is fixed at
 * the first compile, because the stamp is part of the one strings array a URL has.
 * ADR-0119.
 *
 * @type {Map<string, string | null>}
 */
const ownerByUrl = new Map();

/**
 * The latest development revision of each edited template.
 *
 * A request already in flight when the edit arrived resolves afterwards.
 * `fetchAndCompile` returns the revision instead of compiling the stale bytes, which
 * would also create a second strings array for the URL. ADR-0014.
 *
 * @type {Map<string, CompiledTemplate>}
 */
const revisedByUrl = new Map();

/**
 * The group each template belongs to, for groups that haven't started yet.
 *
 * `attachTemplate` runs while a chunk's module body evaluates, which only happens
 * after the router let that chunk load. Starting the group there means markup
 * follows the same guards as code. ADR-0081.
 *
 * `prefetchTemplates` removes entries as it starts them, so each group starts at
 * most once, the entry group included.
 *
 * @type {Map<string, readonly string[]>}
 */
const groupByTemplate = new Map();

/**
 * Load and compile a template, once per URL.
 *
 * The promise is cached, so two components mounting together share one compile.
 *
 * @param {string | URL} url
 * @returns {Promise<CompiledTemplate>}
 */
export function loadTemplate(url) {
  const href = new URL(url, document.baseURI).href;

  let pending = byUrl.get(href);
  if (pending === undefined) {
    if (!ownerByUrl.has(href)) ownerByUrl.set(href, null);
    pending = fetchAndCompile(href);
    byUrl.set(href, pending);
  }
  return pending;
}

/**
 * A template's source, fetched once per URL and not compiled.
 *
 * A seeded bundle returns a string synchronously. A rejection stays cached, so one
 * 404 isn't repeated for every component that mounts.
 *
 * @param {string} href Already resolved against `document.baseURI`.
 * @returns {string | Promise<string>}
 */
function sourceOf(href) {
  let source = sourceByUrl.get(href);
  if (source === undefined) {
    source = fetchSource(href);
    sourceByUrl.set(href, source);
  }
  return source;
}

/**
 * @param {string} href
 * @returns {Promise<string>}
 */
async function fetchSource(href) {
  const response = await fetch(href);
  if (!response.ok) {
    throw new Error(
      `Cannot load template ${href}: ${String(response.status)} ${response.statusText}`,
    );
  }
  return response.text();
}

/**
 * Start fetching a list of templates without waiting for them.
 *
 * A component only learns its template URL when its module evaluates, so nine
 * components in one chunk would otherwise fetch one after another. The build knows
 * the URLs ahead of time, and this starts them together. ADR-0081.
 *
 * Only bytes are fetched. Compiling waits for `attachTemplate`, so the first paint
 * doesn't pay for templates nothing mounts.
 *
 * Duplicates cost nothing. Rejections are swallowed here, and the component that
 * needs the template sees the failure when it awaits.
 *
 * @param {Iterable<string | URL>} urls
 * @returns {void}
 */
export function prefetchTemplates(urls) {
  for (const url of urls) {
    const href = new URL(url, document.baseURI).href;
    // Starting a template counts as starting its group, so the entry group isn't
    // started again by its first component.
    groupByTemplate.delete(href);
    // Mark the cached promise itself as handled, so a 404 stays quiet until someone
    // awaits it.
    const source = sourceOf(href);
    if (typeof source !== 'string') source.catch(() => {});
  }
}

/**
 * Record how the artifact's templates are grouped. Startup calls this once with
 * `AppManifest.templateGroups`.
 *
 * Only membership matters, and the group keys are ignored. Source delivery and
 * `split-lazy` register nothing, so each component fetches its own template.
 * ADR-0081.
 *
 * @param {Readonly<Record<string, readonly string[]>>} groups
 * @returns {void}
 */
export function registerTemplateGroups(groups) {
  for (const urls of Object.values(groups)) {
    const group = urls.map((url) => new URL(url, document.baseURI).href);
    for (const href of group) groupByTemplate.set(href, group);
  }
}

/**
 * Start this template's group, unless it already started.
 *
 * The group includes the template itself, so the request started here is the one
 * the caller awaits. The rest of the group belongs to the chunk evaluating now.
 *
 * @param {string} href Already resolved against `document.baseURI`.
 */
function startTemplateGroup(href) {
  const group = groupByTemplate.get(href);
  if (group !== undefined) prefetchTemplates(group);
}

/**
 * @param {string} href
 * @returns {Promise<CompiledTemplate>}
 */
async function fetchAndCompile(href) {
  const source = await sourceOf(href);
  // A revision published while this request was in flight wins. ADR-0111.
  return revisedByUrl.get(href) ?? compileTemplate(source, href, ownerByUrl.get(href) ?? undefined);
}

/**
 * Fill the source cache from a bundled `{ url: source }` map, so no template needs a
 * request of its own.
 *
 * Compilation is unchanged, so development and production run the same compiler
 * over the same bytes.
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
 * Also starts the rest of this template's chunk group (see `startTemplateGroup`),
 * because this is the only place that knows which chunk is running. ADR-0081.
 *
 * Only `defineComponent` calls this, before `customElements.define`.
 *
 * `owner` is the tag of a styled Element. Every element the template renders carries
 * it as `data-ui-owner`, so one template can't serve two owners, or an owner and an
 * unstyled class.
 *
 * @param {object} ctor
 * @param {string | URL} url
 * @param {string} [owner]
 * @returns {Promise<void>}
 */
export async function attachTemplate(ctor, url, owner) {
  const href = new URL(url, document.baseURI).href;
  const claimed = ownerByUrl.get(href);
  if (claimed === undefined) {
    ownerByUrl.set(href, owner ?? null);
  } else if (claimed !== (owner ?? null)) {
    throw new Error(
      `${href} already renders ${claimed === null ? 'for an unstyled class' : `for <${claimed}>`}, ` +
        `so it cannot also render ${owner === undefined ? 'unstyled' : `for <${owner}>`}. A styled ` +
        'Element stamps its own markup, and one template has one compile. ADR-0119.',
    );
  }
  startTemplateGroup(href);

  // Record the class before awaiting, so an edit that lands mid-request reaches it.
  let attached = attachedByUrl.get(href);
  if (attached === undefined) {
    attached = new Set();
    attachedByUrl.set(href, attached);
  }
  attached.add(ctor);

  byClass.set(ctor, await loadTemplate(href));
}

/**
 * The compiled template registered for a class, if any. `SignalElement.render` reads
 * it.
 *
 * @param {object} ctor
 * @returns {CompiledTemplate | undefined}
 */
export function templateFor(ctor) {
  // Walk the prototype chain, so a subclass inherits its parent's template.
  /** @type {object | null} */
  let current = ctor;
  while (current !== null) {
    const found = byClass.get(current);
    if (found !== undefined) return found;
    // `Reflect.getPrototypeOf` returns `object | null`, where `Object.getPrototypeOf`
    // returns `any`.
    current = Reflect.getPrototypeOf(current);
  }
  return undefined;
}

/* ── Development revisions ─────────────────────────────────────────────── */

/**
 * A host that can be told its markup changed. `SignalElement` implements it.
 *
 * @typedef {{ renderRevisedTemplate?: () => void }} RevisableHost
 */

/**
 * Render an edited `.html` file in the page already showing it. Development only.
 * ADR-0111.
 *
 * Each host stays the same instance, so fields, signals and subscriptions survive.
 * The edit commits only if it compiles, so a half-written file changes nothing.
 * State held by the old DOM, such as focus, scroll and uncontrolled input values, is
 * lost.
 *
 * The new strings array is the one sanctioned exception to ADR-0014.
 *
 * @internal
 * @param {string | URL} url
 * @param {string} source
 * @returns {boolean} Whether this page had the template. `false` means nothing here
 *   asked for that URL, and the next component to mount fetches the edited file.
 */
export function reviseTemplate(url, source) {
  const href = new URL(url, document.baseURI).href;
  if (!sourceByUrl.has(href)) return false;

  const compiled = compileTemplate(source, href, ownerByUrl.get(href) ?? undefined);

  sourceByUrl.set(href, source);
  revisedByUrl.set(href, compiled);
  byUrl.set(href, Promise.resolve(compiled));
  for (const ctor of attachedByUrl.get(href) ?? []) byClass.set(ctor, compiled);

  renderRevision(compiled);
  return true;
}

/**
 * Ask every live host of a revised template to render.
 *
 * Walks the document instead of tracking hosts, so production pays nothing.
 * `templateFor` also matches subclasses. Detached hosts pick up the revision on their
 * next render. Shadow roots aren't walked, because components render into light DOM.
 *
 * @param {CompiledTemplate} compiled
 */
function renderRevision(compiled) {
  for (const element of document.querySelectorAll('*')) {
    if (templateFor(element.constructor) !== compiled) continue;
    // A method call, because signal-element.js imports this module.
    /** @type {RevisableHost} */ (/** @type {unknown} */ (element)).renderRevisedTemplate?.();
  }
}

/* ── Interpolation pre-pass ────────────────────────────────────────────── */

/**
 * `{{ ... }}` bodies are replaced with `⟦n⟧` placeholders before the HTML parser sees
 * the source. Otherwise `{{ a < b }}` would parse as the start of a `<b>` tag.
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
 * Collects the static strings and binding evaluators that become one lit template.
 * The strings array is built once, because lit caches on its identity.
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

  /**
   * @param {Evaluator} evaluator
   * @param {string} where Where the expression is written, for a diagnostics report.
   */
  hole(evaluator, where) {
    // Every binding passes through here with its final evaluator, so the diagnostics
    // label attaches here.
    labelBinding(evaluator, where);
    this.#parts.push(this.#current);
    this.#current = '';
    this.#values.push(evaluator);
  }

  /** @returns {TemplateChunks} */
  finish() {
    this.#parts.push(this.#current);

    const strings = /** @type {string[] & { raw?: readonly string[] }} */ ([...this.#parts]);
    // lit reads `strings.raw`. It is non-enumerable, so the array still looks plain.
    Object.defineProperty(strings, 'raw', { value: Object.freeze([...this.#parts]) });

    return {
      strings: /** @type {TemplateStringsArray} */ (/** @type {unknown} */ (strings)),
      values: this.#values,
    };
  }
}

/**
 * Gives each compiled binding its own signal dependencies and lit Part, so a signal
 * change updates one Part without re-rendering the template.
 *
 * A binding re-evaluates in three cases.
 *
 * 1. A signal it reads changes, and the effect commits this Part.
 * 2. The host renders. Lit properties aren't signals, so the binding runs again in a
 *    fresh effect, which also picks up a branch that reads different signals.
 * 3. Its `*for` row gets a new item or index.
 *
 * Otherwise it does no work. The scope keeps its identity, and `scope.version` says
 * when to re-read. ADR-0014.
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
    return this.#track(evaluate, scope, false, this.#causeOf(evaluate, scope));
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
    return this.#track(evaluate, scope, false, this.#causeOf(evaluate, scope));
  }

  disconnected() {
    this.#dispose?.();
    this.#dispose = undefined;
  }

  reconnected() {
    if (this.#evaluate !== undefined && this.#scope !== undefined) {
      this.#track(this.#evaluate, this.#scope, true, 'reconnect');
    }
  }

  /**
   * Why this evaluation happens. A new evaluator or scope means the Part holds a
   * different binding, such as a flipped `*if` or a moved row. A new version on the
   * same pair means the host rendered or the row changed.
   *
   * @param {Evaluator} evaluate
   * @param {Scope} scope
   * @returns {BindingUpdateCause}
   */
  #causeOf(evaluate, scope) {
    if (this.#version === -1) return 'mount';
    if (evaluate !== this.#evaluate || scope !== this.#scope) return 'rebind';
    return 'rerender';
  }

  /**
   * @param {Evaluator} evaluate
   * @param {Scope} scope
   * @param {boolean} commitInitial
   * @param {BindingUpdateCause} cause
   * @returns {unknown}
   */
  #track(evaluate, scope, commitInitial, cause) {
    this.#dispose?.();
    this.#dispose = undefined;
    this.#evaluate = evaluate;
    this.#scope = scope;
    this.#version = scope.version;

    if (!this.isConnected) {
      // Report detached evaluations too, so the report doesn't undercount.
      const finish = beginBindingUpdate(evaluate, cause);
      const previous = this.#value;
      this.#value = evaluate(scope);
      finish(previous !== this.#value);
      return this.#value;
    }

    let initial = true;
    this.#dispose = effect(() => {
      // Only the first run has the caller's cause. Later runs are the effect waking
      // on a signal.
      const finish = beginBindingUpdate(evaluate, initial ? cause : 'signal');
      const previous = this.#value;
      this.#value = evaluate(scope);
      if (!initial || commitInitial) this.setValue(this.#value);
      finish(previous !== this.#value);
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

/**
 * One rendered `*fragment` instance, holding the row scope for its DOM position.
 *
 * Lit ties a directive instance to its Part, so the scope lives exactly as long as
 * the cell and moves with a keyed row. Locals update in place, and the version
 * changes only when a local or the declaring scope changed. ADR-0014, ADR-0104.
 */
class FragmentDirective extends Directive {
  /** @type {Scope | undefined} */
  #scope;

  /** The declaring `scope.version` this instance's locals were refreshed against. */
  #parentVersion = -1;

  /**
   * @param {TemplateChunks} chunks
   * @param {Scope} parent
   * @param {readonly string[]} params
   * @param {readonly unknown[]} args
   * @returns {unknown}
   */
  render(chunks, parent, params, args) {
    let scope = this.#scope;
    if (scope === undefined) {
      scope = { host: parent.host, locals: childLocals(parent.locals), version: 0 };
      this.#scope = scope;
    }

    let changed = this.#parentVersion !== parent.version;
    for (const [index, param] of params.entries()) {
      const value = args[index];
      // `hasOwn`, because locals are prototype-chained and a parameter must shadow an
      // enclosing `*for` variable with the same name.
      if (Object.hasOwn(scope.locals, param) && scope.locals[param] === value) continue;
      scope.locals[param] = value;
      changed = true;
    }

    if (changed) {
      this.#parentVersion = parent.version;
      scope.version += 1;
    }
    return renderChunks(chunks, scope);
  }
}

const fragmentInstance = directive(FragmentDirective);

/* ── Compiler ──────────────────────────────────────────────────────────── */

/**
 * Compile template source into a render function. Application code uses
 * `loadTemplate`.
 *
 * @param {string} source
 * @param {string} where URL or label used in error messages.
 * @param {string} [owner] The styled Element whose tag every rendered element carries.
 * @returns {CompiledTemplate}
 * @internal
 */
export function compileTemplate(source, where, owner) {
  const { prepared, expressions } = liftInterpolations(source);

  const holder = document.createElement('template');
  setTemplateSource(holder, prepared);

  /** @type {CompileContext} */
  const context = { where, expressions, owner };
  const chunks = new Chunks();
  compileNodes([...holder.content.childNodes], context, chunks);
  const compiled = chunks.finish();

  /**
   * One scope per host, for the host's lifetime. Each render bumps its version
   * instead of allocating a new scope, which would rebuild every binding's effect.
   *
   * @type {WeakMap<object, Scope>}
   */
  const byHost = new WeakMap();

  return (host) => {
    const existing = byHost.get(host);
    if (existing !== undefined) {
      // A lit render. Plain reactive properties aren't signals, so anything may have
      // changed.
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
 * Shared empty locals, never written to.
 *
 * Row locals chain with `Object.create`, so a nested `*for` sees outer variables.
 * The chain ends in `null`, so `{{ toString }}` can't reach `Object.prototype`.
 *
 * @type {TemplateLocals}
 */
const EMPTY_LOCALS = Object.freeze(childLocals(null));

/**
 * A locals object chained to `parent`, or a chain root when given `null`.
 *
 * A helper, because `Object.create` returns `any`.
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
 * @property {string | undefined} owner
 */

/**
 * One `*for` row's scope, and the parent version it was last refreshed against.
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
    else chunks.hole(expressionAt(piece, context, false), interpolationWhere(piece, context));
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
    chunks.hole(
      compileFor(element, structuralFor, context),
      `${context.where} *for="${structuralFor}"`,
    );
    return;
  }

  if (structuralIf !== null) {
    element.removeAttribute('*if');
    chunks.hole(
      compileIf(element, structuralIf, context, consumed),
      `${context.where} *if="${structuralIf}"`,
    );
    return;
  }

  if (element.hasAttribute('*else')) {
    throw new Error(
      `<${tag}> in ${context.where} has *else but the element before it has no *if.`,
    );
  }

  // A `<template>` reaching here lacks a fragment head or an element to belong to.
  // Its children sit in `content`, where nothing would compile them, so throw.
  if (tag === 'template') {
    throw new Error(
      element.hasAttribute('*fragment')
        ? `<template *fragment> in ${context.where} has no element to belong to. ` +
          `A fragment is a property of the element it is written inside.`
        : `<template> in ${context.where} has no *fragment. A template element renders ` +
          `nothing on its own; declare it as <template *fragment="name(row)"> inside ` +
          `the element that renders it.`,
    );
  }

  if (element.hasAttribute('*fragment')) {
    throw new Error(
      `<${tag}> in ${context.where} has *fragment. Only <template> may declare one, ` +
        `so unrendered markup is never mistaken for markup that renders.`,
    );
  }

  // Fragments first, because they compile to property bindings inside the start tag.
  const fragments = takeFragments(element, context);

  chunks.text(`<${tag}`);
  compileAttributes(element, context, chunks);
  if (context.owner !== undefined) chunks.text(` ${OWNER_ATTRIBUTE}="${context.owner}"`);
  for (const fragment of fragments) {
    chunks.text(` .${fragment.property}=`);
    chunks.hole(fragment.evaluate, `${context.where} *fragment ${fragment.property}`);
  }
  chunks.text('>');

  if (!VOID_ELEMENTS.has(tag)) {
    compileNodes([...element.childNodes], context, chunks);
    chunks.text(`</${tag}>`);
  }
}

/**
 * Remove this element's `<template *fragment>` children and compile each into a
 * property binding on the element.
 *
 * @param {Element} element
 * @param {CompileContext} context
 * @returns {{ property: string, evaluate: Evaluator }[]}
 */
function takeFragments(element, context) {
  /** @type {{ property: string, evaluate: Evaluator }[]} */
  const fragments = [];
  /** @type {Set<string>} */
  const seen = new Set();

  for (const child of [...element.children]) {
    const source = child.getAttribute('*fragment');
    if (source === null) continue;
    if (child.localName !== 'template') continue;

    const head = parseFragmentHead(source);
    if (head === undefined) {
      throw new Error(
        `Cannot read *fragment="${source}" in ${context.where}. ` +
          `Expected *fragment="name(local, local)" with distinct local names.`,
      );
    }

    const { property, params } = head;

    // A fragment is a function, and these names only accept strings (event
    // properties, forbidden members, markup or URL sinks), so the name is refused.
    if (
      refusedProperty(property) !== undefined ||
      securityContextFor(element.localName, property) !== undefined
    ) {
      throw new Error(
        `<${element.localName}> in ${context.where} declares *fragment ${property}. ` +
          `That property is a text sink, not a place a fragment can go.`,
      );
    }

    if (seen.has(property)) {
      throw new Error(
        `<${element.localName}> in ${context.where} declares *fragment ${property} twice.`,
      );
    }
    seen.add(property);

    child.remove();
    fragments.push({
      property,
      // `of` only matters to the checker. At runtime a local is whatever was passed.
      evaluate: compileFragment(
        /** @type {HTMLTemplateElement} */ (child),
        property,
        params.map((param) => param.name),
        context,
      ),
    });
  }

  return fragments;
}

/**
 * Compile a fragment body and return the evaluator that binds it to a scope.
 *
 * The function is cached per declaring scope, so the property keeps the same value
 * across renders. A new function on each render would retrigger elements that react
 * to the property, such as `<ui-table-column>`.
 *
 * @param {HTMLTemplateElement} element
 * @param {string} property
 * @param {readonly string[]} params
 * @param {CompileContext} context
 * @returns {Evaluator}
 */
function compileFragment(element, property, params, context) {
  const chunks = new Chunks();
  // The HTML parser puts a template's children in `content`.
  compileNodes([...element.content.childNodes], { ...context, where: `${context.where} *fragment ${property}` }, chunks);
  const body = chunks.finish();

  /** @type {WeakMap<Scope, TemplateFragment>} */
  const byScope = new WeakMap();

  return (scope) => {
    let fragment = byScope.get(scope);
    if (fragment === undefined) {
      fragment = (...args) => fragmentInstance(body, scope, params, args);
      byScope.set(scope, fragment);
    }
    return fragment;
  };
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

    // Only the compiler writes ownership. ADR-0119.
    if (name === OWNER_ATTRIBUTE || name === `[${OWNER_ATTRIBUTE}]`) {
      throw new Error(
        `<${element.localName}> in ${context.where} writes ${OWNER_ATTRIBUTE}, which the ` +
          "template compiler stamps to scope an Element's stylesheet.",
      );
    }

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
            // `childLocals`, because a spread would drop inherited `*for` variables.
            const locals = childLocals(scope.locals);
            locals.$event = domEvent;
            handler({ host: scope.host, locals, version: scope.version });
          },
        `${context.where} (${event})`,
      );
      continue;
    }

    if (syntax.kind === 'binding') {
      compileBinding(element, syntax.target, value, context, chunks);
      continue;
    }

    // A plain attribute may still interpolate, for example
    //   class="rounded border {{ active ? 'bg-sky-50' : 'bg-white' }}"
    const pieces = splitPlaceholders(value);
    if (pieces.length === 1 && typeof pieces[0] === 'string') {
      chunks.text(value === '' ? ` ${name}` : ` ${name}="${escapeAttribute(value)}"`);
      continue;
    }

    const evaluate = compileInterpolatedAttribute(pieces, context);
    const where = `${context.where} ${name} interpolation`;
    chunks.text(` ${name}="`);
    chunks.hole(throughSink(evaluate, attributeSinkFor(element.localName, name, where)), where);
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
    // Resolving the sink also rejects a dangerous target at compile time.
    chunks.text(` .${name}=`);
    chunks.hole(throughSink(evaluate, propertySinkFor(element.localName, name, where)), where);
    return;
  }

  if (classified.kind === 'boolean') {
    chunks.text(` ?${name}=`);
    chunks.hole(evaluate, where);
    return;
  }

  chunks.text(` ${name}="`);
  chunks.hole(throughSink(evaluate, attributeSinkFor(element.localName, name, where)), where);
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
    // Whitespace between the pair goes with the `*else` branch, or it would render as
    // a stray text node.
    for (const between of nodesBetween(element, next)) consumed.add(between);
    alternate = compileSubtree(next, context);
  }

  return (scope) => {
    if (test(scope)) return renderChunks(branch, scope);
    return alternate === undefined ? nothing : renderChunks(alternate, scope);
  };
}

/**
 * `*for="user of users"`, with optional clauses defined in dialect.js. Without `key`,
 * a reorder re-renders every row. `$index`, `$first`, `$last` and `$count` are always
 * in scope.
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
   * Row scopes held by position, per enclosing scope. One compiled `*for` serves
   * every host and every outer row, and the parent scope tells them apart. The key
   * expression can't index these, because it evaluates against a row scope.
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
      // Bump the row's version only when its item, position, list length or host
      // changed, so an unchanged row costs one comparison.
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
    // Drop scopes past the end, so a list that grows again doesn't reuse old locals.
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
 * Compile one element as its own template, so lit can insert and remove a structural
 * directive's body as a unit.
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
  return compileExpression(source, interpolationWhere(index, context), { allowAssignment });
}

/**
 * How one `{{ }}` is named in an error and in a diagnostics report.
 *
 * @param {number} index
 * @param {CompileContext} context
 * @returns {string}
 */
function interpolationWhere(index, context) {
  return `${context.where} {{ ${(context.expressions[index] ?? '').trim()} }}`;
}

/**
 * Compile a plain attribute with `{{ }}` expressions into one value. A single Part
 * lets TrustedHTML reach sinks such as `srcdoc` without string concatenation.
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
      // Plain attributes keep lit's string coercion, so an object renders as its
      // JavaScript string.
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      .map((piece) => (typeof piece === 'string' ? piece : String(piece(scope) ?? '')))
      .join('');
}

/**
 * Wrap a binding's evaluator in the sink chosen at compile time.
 *
 * A binding outside any security context gets no sanitizer. `nothing` removes the
 * attribute for a nullish or refused value.
 *
 * @param {Evaluator} evaluate
 * @param {((value: unknown) => unknown | null) | null} sink
 * @returns {Evaluator}
 */
function throughSink(evaluate, sink) {
  if (sink === null) return (scope) => evaluate(scope) ?? nothing;
  return (scope) => sink(evaluate(scope)) ?? nothing;
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
  // A non-iterable renders nothing. `npm run templates:check` catches it statically.
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
