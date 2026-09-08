/**
 * Which authoring form a document is written in, and what each editor feature may ask
 * of it.
 *
 * This project supports two authored forms over one Element identity: an external srl
 * template, and inline Lit templates inside a JavaScript module. They share tag identity
 * and nothing else — srl directives, bindings and interpolation are not Lit syntax.
 * Building an srl semantic snapshot for every URI offered `*for`, `(click)` and `[.rows]`
 * inside JavaScript, where none of them mean anything, and read a tag written in a
 * comment or a string as markup.
 *
 * Classification and routing live here so no editor feature decides a dialect for itself
 * again. Each form is an adapter behind one view: srl answers the whole surface through
 * `semantics.mjs`, Lit answers tag identity only. Richer Lit analysis deepens behind that
 * adapter without a caller changing. ADR-0090, ADR-0092.
 */

import { litTags, TemplateSemantics } from './semantics.mjs';

/** @import { ElementRecord, ProjectModel } from '../project-model/types.js' */

/** @typedef {'srl' | 'lit' | 'none'} AuthoredForm */
/** @typedef {{ name: string, start: number, end: number }} TagIdentity */
/**
 * @typedef {{
 *   form: AuthoredForm,
 *   roots: TemplateSemantics['roots'],
 *   at: (offset: number) => ReturnType<TemplateSemantics['at']> | { kind: 'none' },
 *   tagAt: (offset: number) => TagIdentity | undefined,
 *   tags: (name: string) => ReturnType<TemplateSemantics['tags']>,
 *   membersAt: (offset: number) => ReturnType<TemplateSemantics['membersAt']>,
 *   highlights: () => Array<{ start: number, length: number, type: number }>,
 *   addUse: (target: ElementRecord) => ReturnType<TemplateSemantics['addUse']>,
 * }} AuthoredView
 */

const TOKEN_TYPES = {
  event: 11,
  keyword: 15,
  method: 12,
  operator: 21,
  property: 9,
  variable: 8,
};

/** The neutral answer to every srl-grammar question. */
const NO_CONTEXT = /** @type {const} */ ({ kind: 'none' });

/**
 * The authored forms of one repository, and one view per document.
 */
export class AuthoredTemplates {
  /** @type {Map<string, { text: string, version?: number }>} */
  #documents;

  /** @param {{ documents: Map<string, { text: string, version?: number }> }} input */
  constructor(input) {
    this.#documents = input.documents;
  }

  /** @param {string} path @returns {AuthoredForm} */
  form(path) {
    if (path.endsWith('.html')) return 'srl';
    if (/\.m?js$/u.test(path)) return 'lit';
    return 'none';
  }

  /**
   * @param {{ path: string, source: string, model: ProjectModel, component?: ElementRecord }} input
   * @returns {AuthoredView}
   */
  view(input) {
    switch (this.form(input.path)) {
      case 'srl':
        return srlView(
          new TemplateSemantics({
            source: input.source,
            where: input.path,
            model: input.model,
            component: input.component,
            documents: this.#documents,
          }),
          input.source,
        );
      case 'lit':
        return litView(input.source);
      default:
        return emptyView();
    }
  }
}

/** @param {TemplateSemantics} semantics @param {string} source @returns {AuthoredView} */
function srlView(semantics, source) {
  return {
    form: 'srl',
    roots: semantics.roots,
    at: (offset) => semantics.at(offset),
    tagAt: (offset) => {
      const context = semantics.at(offset);
      return context.kind === 'tag'
        ? { name: context.name, start: context.start, end: context.end }
        : undefined;
    },
    tags: (name) => semantics.tags(name),
    membersAt: (offset) => semantics.membersAt(offset),
    highlights: () => highlights(source, semantics.expressionSpans()),
    addUse: (target) => semantics.addUse(target),
  };
}

/**
 * Inline Lit markup, which shares tag identity with an srl template and no other syntax.
 *
 * The scan is deferred because most questions asked of a JavaScript document — every
 * completion keystroke among them — are answered without it, and it parses the module.
 *
 * @param {string} source
 * @returns {AuthoredView}
 */
function litView(source) {
  /** @type {ReturnType<typeof litTags> | undefined} */
  let scanned;
  const spans = () => (scanned ??= litTags(source));
  return {
    form: 'lit',
    roots: [],
    at: () => NO_CONTEXT,
    tagAt: (offset) => spans().find((span) => span.start <= offset && offset <= span.end),
    tags: (name) =>
      spans()
        .filter((span) => span.name === name)
        .map(({ start, end }) => ({ start, end })),
    membersAt: () => undefined,
    highlights: () => [],
    addUse: () => Promise.resolve(null),
  };
}

/** @returns {AuthoredView} A document written in neither authored form. */
function emptyView() {
  return {
    form: 'none',
    roots: [],
    at: () => NO_CONTEXT,
    tagAt: () => undefined,
    tags: () => [],
    membersAt: () => undefined,
    highlights: () => [],
    addUse: () => Promise.resolve(null),
  };
}

/**
 * srl grammar worth colouring beyond what native HTML highlighting already knows.
 *
 * @param {string} source
 * @param {Array<{ start: number, end: number }>} expressions
 */
function highlights(source, expressions) {
  /** @type {Array<{ start: number, length: number, type: number }>} */
  const spans = [];
  addPattern(/\{\{|\}\}/gu, TOKEN_TYPES.operator);
  addPattern(/\*(?:if|else|for)\b/gu, TOKEN_TYPES.keyword);
  addCaptured(/\(([A-Za-z][\w:-]*)\)/gu, 1, TOKEN_TYPES.event);
  addCaptured(/\[([.?]?[A-Za-z][\w:-]*)\]/gu, 1, TOKEN_TYPES.property);
  for (const expression of expressions) {
    const text = source.slice(expression.start, expression.end);
    for (const match of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/gu)) {
      const start = expression.start + (match.index ?? 0);
      const after = text.slice((match.index ?? 0) + match[0].length).trimStart()[0];
      spans.push({
        start,
        length: match[0].length,
        type: after === '(' ? TOKEN_TYPES.method : TOKEN_TYPES.variable,
      });
    }
  }
  return spans
    .sort((left, right) => left.start - right.start || right.length - left.length)
    .filter((span, index, all) => index === 0 || span.start >= (all[index - 1]?.start ?? 0) + (all[index - 1]?.length ?? 0));

  /** @param {RegExp} pattern @param {number} type */
  function addPattern(pattern, type) {
    for (const match of source.matchAll(pattern)) {
      spans.push({ start: match.index ?? 0, length: match[0].length, type });
    }
  }

  /** @param {RegExp} pattern @param {number} group @param {number} type */
  function addCaptured(pattern, group, type) {
    for (const match of source.matchAll(pattern)) {
      const value = match[group];
      if (value === undefined) continue;
      spans.push({ start: (match.index ?? 0) + match[0].indexOf(value), length: value.length, type });
    }
  }
}
