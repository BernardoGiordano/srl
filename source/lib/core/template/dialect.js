/**
 * The template dialect: what a binding may say and what each sink means.
 *
 * `core/template/template.js` evaluates the dialect in the browser, and
 * `cli/checks/template-check.mjs` emits TypeScript for it in Node. Both import the
 * grammar from here, and `tools/checks/readme-check.mjs` writes the template reference
 * page from the same tables. The module imports nothing, so Node can load it directly.
 *
 * This module holds tables and parsing only. Sanitizing lives in security.js,
 * evaluation in template.js and emission in the checker.
 */

/** @import { SecurityContext, TargetClassification } from '@core/template/types.js' */

/* ── Element and attribute tables ──────────────────────────────────────── */

/**
 * HTML void elements. lit-html's template parse needs balanced tags, and the checker
 * needs the list to know that `<img>` opens no scope.
 *
 * @internal
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
 * Boolean attributes, bound with lit's `?` semantics even without the `?`. So
 * `[disabled]="isBusy"` removes the attribute when `isBusy` is false.
 *
 * @internal
 */
export const BOOLEAN_ATTRIBUTES = new Set([
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
 * `{{ ... }}`. Global and safe to share, because `replace` resets `lastIndex` and
 * `matchAll` iterates over a clone.
 *
 * @internal
 */
export const INTERPOLATION = /\{\{([\s\S]*?)\}\}/gu;

/**
 * `*for="user of users"`, optionally followed by a key clause or an index clause.
 *
 *     *for="user of users; key: user.id"      keyed, reorders instead of rebuilding
 *     *for="user of users; index as position" names the index
 *
 * @internal
 */
export const FOR_HEAD = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s+of\s+([\s\S]+)$/u;
/** @internal */
export const FOR_KEY_CLAUSE = /^key\s*:\s*([\s\S]+)$/u;
/** @internal */
export const FOR_INDEX_CLAUSE = /^index\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/u;

/**
 * The locals every `*for` row has in scope besides its own alias. The runtime sets them
 * from `value`, and the checker and the editor declare them with `type`.
 *
 * @type {ReadonlyArray<{ name: string, type: 'number' | 'boolean', meaning: string, value: (index: number, count: number) => number | boolean }>}
 * @internal
 */
export const FOR_LOCALS = Object.freeze([
  { name: '$index', type: 'number', meaning: 'Position of the row, from 0.', value: (index) => index },
  { name: '$first', type: 'boolean', meaning: 'True for the first row.', value: (index) => index === 0 },
  {
    name: '$last',
    type: 'boolean',
    meaning: 'True for the last row.',
    value: (index, count) => index === count - 1,
  },
  { name: '$count', type: 'number', meaning: 'Number of rows in the list.', value: (_index, count) => count },
]);

/**
 * `<template *fragment="cell(row of people, index)">` declares markup the enclosing
 * element renders later, with `row` and `index` as locals.
 *
 * The head reads like a function signature. The name is the property the fragment is
 * assigned to, kebab-cased like other property bindings. The consumer calls it
 * positionally, so `<ui-table-column>` passes `(row, index, value)`.
 *
 * `of` names where a local's type comes from, as in `*for`. A table types its rows
 * `unknown`, so the page states the row type here. Parentheses and commas can't
 * appear inside the head, which keeps the split unambiguous. ADR-0104.
 *
 * @internal
 */
export const FRAGMENT_HEAD = /^\s*([A-Za-z][A-Za-z0-9-]*)\s*\(([^()]*)\)\s*$/u;

/** One parameter: a name, optionally with the iterable its element type comes from. */
const FRAGMENT_PARAM = /^([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+of\s+(\S[\s\S]*))?$/u;

/**
 * Read a `*fragment` head, or `undefined` when it isn't one. Shared, so the runtime
 * and the checker split parameters the same way.
 *
 * @param {string} source
 * @returns {{ property: string, params: { name: string, iterable: string | undefined }[] } | undefined}
 * @internal
 */
export function parseFragmentHead(source) {
  const parsed = FRAGMENT_HEAD.exec(source);
  if (parsed === null) return undefined;

  const [, name = '', list = ''] = parsed;
  if (name === '') return undefined;

  /** @type {{ name: string, iterable: string | undefined }[]} */
  const params = [];
  const trimmed = list.trim();
  if (trimmed !== '') {
    for (const piece of trimmed.split(',')) {
      const param = FRAGMENT_PARAM.exec(piece.trim());
      if (param?.[1] === undefined) return undefined;
      params.push({ name: param[1], iterable: param[2]?.trim() });
    }
  }

  if (new Set(params.map((param) => param.name)).size !== params.length) return undefined;
  return { property: camelCase(name), params };
}

/**
 * Member names an expression may never use. Templates are authored code, so this is
 * no sandbox. It keeps `{{ thing.constructor }}` useless as part of a gadget chain.
 *
 * @internal
 */
export const FORBIDDEN_MEMBERS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Why a member operation is refused, or `undefined` if it's allowed.
 *
 * Every operation that names a member asks here, whether it reads, calls, writes
 * directly, writes through a computed key or builds an object. The parser and the
 * evaluator report the same message.
 *
 * @param {string} name
 * @returns {string | undefined}
 * @internal
 */
export function refusedMember(name) {
  return FORBIDDEN_MEMBERS.has(name) ? `Templates may not access "${name}"` : undefined;
}

/**
 * Convert a kebab-case name to camelCase, as `dataset` does. The HTML parser
 * lowercases attribute names, so property bindings are written kebab-case.
 *
 * @param {string} name
 * @returns {string}
 * @internal
 */
export function camelCase(name) {
  return name.replace(/-([a-z])/gu, (_all, char) => (typeof char === 'string' ? char.toUpperCase() : ''));
}

/**
 * Map `==` and `!=` to `===` and `!==`, matching the `eqeqeq` lint rule. The
 * evaluator and the emitter both use it, so a comparison means the same thing to the
 * checker and at runtime.
 *
 * @param {string} operator
 * @returns {string}
 * @internal
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
 * `(click)` is an event, `[href]` is a binding, `onclick` is an inline handler and
 * always an error, and anything else is a plain attribute that may interpolate.
 *
 * @param {string} name
 * @returns {{ kind: 'event', event: string }
 *   | { kind: 'binding', target: string }
 *   | { kind: 'inline-handler', event: string }
 *   | { kind: 'plain' }}
 *
 * @internal
 */
export function classifyAttributeName(name) {
  if (name.startsWith('(') && name.endsWith(')')) return { kind: 'event', event: name.slice(1, -1) };
  if (name.startsWith('[') && name.endsWith(']')) return { kind: 'binding', target: name.slice(1, -1) };
  // The parser already lowercased the name, and the evaluator refuses the same shape,
  // so both reject the same attributes.
  if (name.startsWith('on')) return { kind: 'inline-handler', event: name.slice(2) };
  return { kind: 'plain' };
}

/**
 * Classify what is inside a binding's brackets, such as `href`, `?disabled` or
 * `.max-rows`.
 *
 * `property` carries the camelCased name. `boolean` carries the name without `?`,
 * because a known boolean attribute is boolean either way.
 *
 * @param {string} target
 * @returns {TargetClassification}
 * @internal
 */
export function classifyBindingTarget(target) {
  if (target === '') return { kind: 'empty-attribute', name: '' };

  // `.onclick` doesn't match here. It is classified as a property and refused later
  // by name.
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
 * Element and attribute pairs that load an executable or embeddable resource. They
 * accept only a reviewed `bypassSecurityTrustResourceUrl` value.
 *
 * @internal
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

/** Attributes browsers fetch or navigate to, in any element. @internal */
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

/** Names that parse their value as markup, in any element. Lowercase. @internal */
export const HTML_SINKS = new Set(['innerhtml', 'srcdoc']);

/** Names that parse their value as CSS, in any element. Lowercase. @internal */
export const STYLE_SINKS = new Set(['csstext', 'style']);

/** Names that hold a list of URLs, in any element. @internal */
export const URL_SET_SINKS = new Set(['srcset']);

/**
 * The security context of a value written to `tag`.`name`, or `undefined` when
 * escaping is enough.
 *
 * Attributes and properties share one answer, since `src` is the same sink either
 * way.
 *
 * @param {string} tag
 * @param {string} name
 * @returns {SecurityContext | undefined}
 * @internal
 */
export function securityContextFor(tag, name) {
  const lower = name.toLowerCase();
  if (RESOURCE_URL_SINKS.has(`${tag.toLowerCase()}:${lower}`)) return 'resourceUrl';
  if (HTML_SINKS.has(lower)) return 'html';
  if (STYLE_SINKS.has(lower)) return 'style';
  if (URL_SET_SINKS.has(lower)) return 'urlSet';
  if (URL_ATTRIBUTES.has(lower)) return 'url';
  return undefined;
}

/**
 * Why a property binding is refused, or `undefined` if it's allowed. It returns a
 * tag, so both adapters agree on which properties and phrase their own messages.
 *
 * @param {string} name camelCased property name.
 * @returns {'event-property' | 'outer-html' | 'forbidden-member' | undefined}
 * @internal
 */
export function refusedProperty(name) {
  if (name.toLowerCase().startsWith('on')) return 'event-property';
  if (name === 'outerHTML') return 'outer-html';
  if (FORBIDDEN_MEMBERS.has(name)) return 'forbidden-member';
  return undefined;
}
