/**
 * The template dialect: what a binding may say, and what each sink means.
 *
 * The dialect has two implementations by design — `core/template/template.js`
 * evaluates it in the browser, `tools/checks/template-check.mjs` emits TypeScript
 * for it in Node — and two adapters over one grammar is a good seam. Two *copies*
 * of the grammar is not: the tables, the directive regexes and the binding-syntax
 * dispatch were restated on both sides and had already drifted three ways.
 *
 * So the grammar lives here and both sides import it. Like
 * `expression-parser.js`, this module imports nothing at all — not signals, not
 * the DOM — so Node can load it directly and no future import can quietly make it
 * browser-only.
 *
 * What belongs here: which attributes are boolean, which elements are void, how a
 * directive head is written, which sink puts a value in a security context, and
 * how an attribute name is classified. What does not: anything that *acts*.
 * Sanitizing is security.js, evaluating is template.js, emitting is the checker.
 */

/** @import { SecurityContext, TargetClassification } from '@core/template/types.js' */

/* ── Element and attribute tables ──────────────────────────────────────── */

/**
 * HTML void elements. Emitting `</img>` would be ignored by the document
 * parser, but lit-html's own template parse is stricter about balance, and the
 * checker needs the same list to know an unclosed `<img>` does not open a scope.
 */
export const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);

/**
 * Boolean attributes, bound with lit's `?` semantics even when written without
 * one. `[disabled]="isBusy"` must remove the attribute when `isBusy` is false,
 * and a plain attribute binding would instead set `disabled="false"`.
 */
const BOOLEAN_ATTRIBUTES = new Set([
  'autofocus',
  'checked',
  'default',
  'disabled',
  'hidden',
  'inert',
  'ismap',
  'loop',
  'multiple',
  'muted',
  'novalidate',
  'open',
  'readonly',
  'required',
  'reversed',
  'selected',
]);

/* ── Directive syntax ──────────────────────────────────────────────────── */

/**
 * `{{ ... }}`. Global, and both call sites are safe with a shared instance:
 * `String.prototype.replace` resets `lastIndex`, and `matchAll` iterates over a
 * clone rather than this regex.
 */
export const INTERPOLATION = /\{\{([\s\S]*?)\}\}/gu;

/**
 * `*for="user of users"`, with two optional clauses:
 *
 *     *for="user of users; key: user.id"      keyed, reorders instead of rebuilding
 *     *for="user of users; index as position" names the index
 */
export const FOR_HEAD = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s+of\s+([\s\S]+)$/u;
export const FOR_KEY_CLAUSE = /^key\s*:\s*([\s\S]+)$/u;
export const FOR_INDEX_CLAUSE = /^index\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/u;

/**
 * Member names an expression may never name, and identifiers it may never
 * resolve. A template expression is authored data rather than user input, so
 * this is not a sandbox: it exists so `{{ thing.constructor }}` resolves to
 * nothing useful and a template can never be the interesting half of a gadget
 * chain.
 */
export const FORBIDDEN_MEMBERS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Why a member operation is refused, or `undefined` if it is allowed.
 *
 * Reads were the only operation that consulted this list, so `x.__proto__`
 * threw while `x.__proto__ = y`, `x['__proto__'] = y` and `{ __proto__: y }`
 * went through and changed a prototype. The rule is about the *name*, not about
 * the direction the value travels, so every operation that names a member —
 * read, call, direct write, computed write, object construction — asks here.
 *
 * The message is the dialect's too, so the parser refusing a name it can see and
 * the evaluator refusing a key it can only compute say the same sentence.
 *
 * @param {string} name
 * @returns {string | undefined}
 */
export function refusedMember(name) {
  return FORBIDDEN_MEMBERS.has(name) ? `Templates may not access "${name}"` : undefined;
}

/**
 * Attribute *names* are lowercased by the HTML parser, which is why property
 * bindings are written kebab-case and converted here, exactly as `dataset` does.
 *
 * @param {string} name
 * @returns {string}
 */
export function camelCase(name) {
  return name.replace(/-([a-z])/gu, (_all, char) => (typeof char === 'string' ? char.toUpperCase() : ''));
}

/**
 * `==` and `!=` are accepted by the grammar and then mean `===` and `!==`,
 * matching the `eqeqeq` rule the rest of the codebase lints for. Loose equality
 * in a template would be the only place in the project where it is legal.
 *
 * The evaluator and the emitter both normalise through this, so a template
 * cannot type-check under one meaning and run under the other.
 *
 * @param {string} operator
 * @returns {string}
 */
export function strictOperator(operator) {
  if (operator === '==') return '===';
  if (operator === '!=') return '!==';
  return operator;
}

/* ── Binding-syntax dispatch ───────────────────────────────────────────── */

/**
 * Classify an attribute name as written in the template.
 *
 * `(click)` is an event, `[href]` is a binding whose target still needs
 * `classifyBindingTarget`, `onclick=` is an inline handler and always an error,
 * and everything else is a plain attribute whose value may still interpolate.
 *
 * @param {string} name
 * @returns {{ kind: 'event', event: string }
 *   | { kind: 'binding', target: string }
 *   | { kind: 'inline-handler', event: string }
 *   | { kind: 'plain' }}
 */
export function classifyAttributeName(name) {
  if (name.startsWith('(') && name.endsWith(')')) return { kind: 'event', event: name.slice(1, -1) };
  if (name.startsWith('[') && name.endsWith(']')) return { kind: 'binding', target: name.slice(1, -1) };
  // Deliberately `startsWith` on the raw name: the HTML parser has already
  // lowercased it, and the evaluator refuses the same shape, so the checker and
  // the runtime reject exactly the same attributes.
  if (name.startsWith('on')) return { kind: 'inline-handler', event: name.slice(2) };
  return { kind: 'plain' };
}

/**
 * Classify what is inside the brackets of a binding: `href`, `?disabled`,
 * `.max-rows`.
 *
 * `property` carries the camelCased name, because that is the only form either
 * adapter uses. `boolean` carries the name without its `?`, since a known
 * boolean attribute is boolean whether or not one was written.
 *
 * @param {string} target
 * @returns {TargetClassification}
 */
export function classifyBindingTarget(target) {
  if (target === '') return { kind: 'empty-attribute', name: '' };

  // `.onclick` does not match: a property binding is classified as a property
  // and refused later by name, with a message about event *properties*.
  if (target.toLowerCase().startsWith('on')) return { kind: 'inline-handler', name: target };

  if (target.startsWith('.')) {
    const property = camelCase(target.slice(1));
    if (property === '') return { kind: 'empty-property', name: '' };
    return { kind: 'property', name: property };
  }

  if (target.startsWith('?')) return { kind: 'boolean', name: target.slice(1) };
  if (BOOLEAN_ATTRIBUTES.has(target)) return { kind: 'boolean', name: target };

  return { kind: 'attribute', name: target };
}

/* ── Sinks and their security contexts ─────────────────────────────────── */

/**
 * Element/attribute pairs that load an executable or embeddable resource. A
 * string is never enough for these; they require a reviewed
 * `bypassSecurityTrustResourceUrl`.
 */
export const RESOURCE_URL_SINKS = new Set([
  'base:href',
  'embed:src',
  'frame:src',
  'iframe:src',
  'link:href',
  'object:data',
  'script:src',
]);

/** Attributes browsers fetch or navigate to, in any element. */
export const URL_ATTRIBUTES = new Set([
  'action',
  'background',
  'cite',
  'data',
  'formaction',
  'href',
  'manifest',
  'poster',
  'src',
  'xlink:href',
]);

/**
 * The security context a value lands in when written to `tag`.`name`, or
 * `undefined` for an ordinary sink where escaping is enough.
 *
 * One function for attributes and properties both: `src` is the same sink
 * whether it is reached as an attribute or as a property, and the two adapters
 * disagreeing about that was how `[.srcset]` ended up unchecked.
 *
 * @param {string} tag
 * @param {string} name
 * @returns {SecurityContext | undefined}
 */
export function securityContextFor(tag, name) {
  const lower = name.toLowerCase();
  if (RESOURCE_URL_SINKS.has(`${tag.toLowerCase()}:${lower}`)) return 'resourceUrl';
  if (lower === 'srcdoc' || lower === 'innerhtml') return 'html';
  if (lower === 'style' || lower === 'csstext') return 'style';
  if (lower === 'srcset') return 'urlSet';
  if (URL_ATTRIBUTES.has(lower)) return 'url';
  return undefined;
}

/**
 * Why a property binding is refused outright, or `undefined` if it is allowed.
 * A tag rather than a sentence: both adapters must agree on *which* properties
 * are refused, while each phrases its own diagnostic.
 *
 * @param {string} name camelCased property name.
 * @returns {'event-property' | 'outer-html' | 'forbidden-member' | undefined}
 */
export function refusedProperty(name) {
  if (name.toLowerCase().startsWith('on')) return 'event-property';
  if (name === 'outerHTML') return 'outer-html';
  if (FORBIDDEN_MEMBERS.has(name)) return 'forbidden-member';
  return undefined;
}
