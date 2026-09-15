/**
 * Which authoring form a document is written in, and what each editor feature may ask
 * of it.
 *
 * This project supports two authored forms over one Element identity: an external srl
 * template, and inline Lit templates inside a JavaScript module. They share tag identity
 * and element nesting, and nothing else — srl directives, bindings and interpolation are
 * not Lit syntax. Building an srl semantic snapshot for every URI offered `*for`,
 * `(click)` and `[.rows]` inside JavaScript, where none of them mean anything, and read a
 * tag written in a comment or a string as markup.
 *
 * Classification and routing live here so no editor feature decides a dialect for itself
 * again. Each form is an adapter behind one view, and the binding surface each one
 * completes, describes and resolves belongs to the adapter rather than to the feature
 * asking. srl writes `[.row-key]="expr"`; Lit writes `.rowKey=${expr}` for the same
 * property of the same element. ADR-0090, ADR-0090.
 *
 * What a feature asks the view for is deliberately narrower for Lit. A substitution is
 * the module's own JavaScript, so TypeScript already completes, types and navigates it;
 * answering there again would put a second, worse completion list over a correct one.
 * The view therefore reports a substitution as the binding that owns it and stops.
 */

import { litSource, TemplateSemantics } from './semantics.mjs';

/** @import { ElementRecord, ProjectModel } from '../project-model/types.js' */

/** @typedef {'srl' | 'lit' | 'none'} AuthoredForm */
/** @typedef {{ name: string, start: number, end: number }} TagIdentity */
/** @typedef {Array<Record<string, unknown>>} CompletionItems */
/** @typedef {{ tag: string, record: ElementRecord, at: number }} UnavailableTag */
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
 *   attributeCompletions: (tag: string, record: ElementRecord | undefined) => CompletionItems,
 *   attributeHover: (name: string, record: ElementRecord | undefined) => string | null,
 *   boundProperty: (name: string) => string | null,
 *   unavailableTags: (model: ProjectModel, owner: ElementRecord) => UnavailableTag[],
 * }} AuthoredView
 */

const TOKEN_TYPES = {
  class: 2,
  event: 11,
  keyword: 15,
  method: 12,
  operator: 21,
  property: 9,
  variable: 8,
};

/** The neutral answer to every grammar question the current form cannot answer. */
const NO_CONTEXT = /** @type {const} */ ({ kind: 'none' });

/**
 * A Lit binding's value is a substitution, so the snippet writes one and leaves the
 * caret inside it. `\$` is a literal dollar in LSP snippet syntax; `$1` is the tabstop.
 */
const SUBSTITUTION = '\\${$1}';

const COMMON_ATTRIBUTES = [
  'class',
  'id',
  'title',
  'role',
  'slot',
  'hidden',
  'tabindex',
  'aria-label',
  'data-testid',
];

const COMMON_EVENTS = [
  'blur',
  'change',
  'click',
  'focus',
  'input',
  'keydown',
  'keyup',
  'pointerdown',
  'pointerup',
  'submit',
];

const NATIVE_ELEMENT_SURFACES = new Map([
  [
    'input',
    {
      attributes: [
        'accept',
        'autocomplete',
        'checked',
        'disabled',
        'max',
        'maxlength',
        'min',
        'minlength',
        'multiple',
        'name',
        'pattern',
        'placeholder',
        'readonly',
        'required',
        'step',
        'type',
        'value',
      ],
      boolean: ['checked', 'disabled', 'multiple', 'readonly', 'required'],
      properties: ['checked', 'disabled', 'files', 'value', 'valueAsDate', 'valueAsNumber'],
    },
  ],
]);

const DIRECTIVES = [
  {
    label: '*if',
    detail: 'Render this element when the expression is truthy.',
    insertText: '*if="$1"',
  },
  {
    label: '*else',
    detail: 'Render this element when the preceding *if is false.',
    insertText: '*else',
  },
  {
    label: '*for',
    detail: 'Repeat this element for an iterable, with an optional stable key.',
    insertText: '*for="${1:item} of ${2:items}; key: ${1:item}.${3:id}"',
  },
];

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
    const form = this.form(input.path);
    if (form === 'none') return emptyView();
    /** @param {string} source */
    const semantics = (source) =>
      new TemplateSemantics({
        source,
        where: input.path,
        model: input.model,
        component: input.component,
        documents: this.#documents,
        dialect: form,
      });
    return form === 'srl'
      ? srlView(semantics(input.source), input.source)
      : litView(input.source, semantics);
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
    highlights: () => srlHighlights(source, semantics.expressionSpans()),
    addUse: (target) => semantics.addUse(target),
    attributeCompletions: srlAttributeCompletions,
    attributeHover: srlAttributeHover,
    boundProperty: srlBoundProperty,

    // The checker reports an unavailable tag in an external template already, with the
    // element type it built for that tag. Reporting it again here would duplicate it.
    unavailableTags: () => [],
  };
}

/**
 * Inline Lit markup, which shares tag identity and element nesting with an srl template
 * and writes every binding in its own syntax.
 *
 * The scan is deferred because most questions asked of a JavaScript document — every
 * completion keystroke among them — are answered without it, and it parses the module.
 *
 * @param {string} source
 * @param {(source: string) => TemplateSemantics} build
 * @returns {AuthoredView}
 */
function litView(source, build) {
  /** @type {TemplateSemantics | null | undefined} */
  let scanned;
  const markup = () => {
    if (scanned === undefined) {
      const text = litSource(source);
      scanned = text === null ? null : build(text);
    }
    return scanned;
  };

  return {
    form: 'lit',

    // A module's outline is its declarations. The JavaScript language service owns it,
    // and an element tree listed beside it would compete with it rather than add to it.
    roots: [],

    at: (offset) => markup()?.at(offset) ?? NO_CONTEXT,
    tagAt: (offset) => {
      const context = markup()?.at(offset);
      return context?.kind === 'tag'
        ? { name: context.name, start: context.start, end: context.end }
        : undefined;
    },
    tags: (name) => markup()?.tags(name) ?? [],

    // A substitution is the module's own JavaScript, which TypeScript already completes.
    membersAt: () => undefined,

    highlights: () => litHighlights(markup()),
    addUse: (target) => markup()?.addUse(target) ?? Promise.resolve(null),
    attributeCompletions: litAttributeCompletions,
    attributeHover: litAttributeHover,
    boundProperty: litBoundProperty,
    unavailableTags: (model, owner) => unavailableTags(markup(), model, owner),
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
    attributeCompletions: () => [],
    attributeHover: () => null,
    boundProperty: () => null,
    unavailableTags: () => [],
  };
}

/**
 * Custom elements this module's inline markup names and its `uses` list does not carry.
 *
 * `uses` is what makes an element exist in the browser, and markup built in JavaScript
 * depends on it exactly as markup in a template file does. Only elements the project
 * model knows are reported: a tag it has never seen may belong to a library this list
 * does not govern, and calling that a missing `uses` entry would be a guess.
 *
 * A bare `customElements.define` has no `uses` list, so it has no entry to be missing.
 * Its imports are what register the tags its markup names, and reading those the way
 * `defineComponent` is read would report a rule it never opted into.
 *
 * @param {TemplateSemantics | null} semantics
 * @param {ProjectModel} model
 * @param {ElementRecord} owner
 * @returns {UnavailableTag[]}
 */
function unavailableTags(semantics, model, owner) {
  if (semantics === null || owner.kind !== 'defineComponent') return [];
  const available = new Set(owner.usesTags);
  const found = [];
  for (const span of semantics.tagSpans()) {
    if (!span.opening || available.has(span.name)) continue;
    const record = model.elements.get(span.name);
    if (record === undefined) continue;
    found.push({ tag: span.name, record, at: span.start });
  }
  return found;
}

/** @param {string} tag @param {ElementRecord | undefined} record @returns {CompletionItems} */
function srlAttributeCompletions(tag, record) {
  const native = NATIVE_ELEMENT_SURFACES.get(tag);
  /** @type {CompletionItems} */
  const found = DIRECTIVES.map((directive) => ({
    ...directive,
    kind: 14,
    insertTextFormat: 2,
  }));
  const customEvents = new Map(record?.events.map((event) => [event.name, event]) ?? []);
  for (const event of new Set([...COMMON_EVENTS, ...customEvents.keys()])) {
    const custom = customEvents.get(event);
    found.push({
      label: `(${event})`,
      kind: 23,
      detail: custom === undefined ? 'srl event binding' : `${record?.className ?? tag} event`,
      insertText: `(${event})="$1"`,
      insertTextFormat: 2,
    });
  }
  for (const name of attributeNames(native, record)) {
    found.push({
      label: name,
      kind: 10,
      detail: record?.observedAttributes?.includes(name) === true ? `${record.className} attribute` : 'HTML attribute',
      insertText: `${name}="$1"`,
      insertTextFormat: 2,
    });
    found.push({
      label: `[${name}]`,
      kind: 10,
      detail: 'srl attribute binding',
      insertText: `[${name}]="$1"`,
      insertTextFormat: 2,
    });
    if (native?.boolean.includes(name) === true) {
      found.push({
        label: `[?${name}]`,
        kind: 10,
        detail: 'srl boolean attribute binding',
        insertText: `[?${name}]="$1"`,
        insertTextFormat: 2,
      });
    }
  }
  for (const property of propertyNames(native, record)) {
    const kebab = kebabCase(property);
    found.push({
      label: `[.${kebab}]`,
      kind: 10,
      detail: `${record?.className ?? 'custom element'} property: ${property}`,
      insertText: `[.${kebab}]="$1"`,
      insertTextFormat: 2,
    });
  }
  return found;
}

/**
 * Lit's binding syntax over the same Element surface.
 *
 * `.rowKey` rather than `[.row-key]`: a Lit property binding names the JavaScript
 * property, so the label is the property. srl directives are absent because Lit has no
 * `*if`, `*for` or `*fragment` — its conditionals and loops are the expressions inside
 * substitutions.
 *
 * @param {string} tag @param {ElementRecord | undefined} record @returns {CompletionItems}
 */
function litAttributeCompletions(tag, record) {
  const native = NATIVE_ELEMENT_SURFACES.get(tag);
  /** @type {CompletionItems} */
  const found = [];
  const customEvents = new Map(record?.events.map((event) => [event.name, event]) ?? []);
  for (const event of new Set([...COMMON_EVENTS, ...customEvents.keys()])) {
    const custom = customEvents.get(event);
    found.push({
      label: `@${event}`,
      kind: 23,
      detail: custom === undefined ? 'Lit event binding' : `${record?.className ?? tag} event`,
      insertText: `@${event}=${SUBSTITUTION}`,
      insertTextFormat: 2,
    });
  }
  for (const name of attributeNames(native, record)) {
    found.push({
      label: name,
      kind: 10,
      detail: record?.observedAttributes?.includes(name) === true ? `${record.className} attribute` : 'HTML attribute',
      insertText: `${name}="$1"`,
      insertTextFormat: 2,
    });
    if (native?.boolean.includes(name) === true) {
      found.push({
        label: `?${name}`,
        kind: 10,
        detail: 'Lit boolean attribute binding',
        insertText: `?${name}=${SUBSTITUTION}`,
        insertTextFormat: 2,
      });
    }
  }
  for (const property of propertyNames(native, record)) {
    found.push({
      label: `.${property}`,
      kind: 10,
      detail: `${record?.className ?? 'custom element'} property: ${property}`,
      insertText: `.${property}=${SUBSTITUTION}`,
      insertTextFormat: 2,
    });
  }
  return found;
}

/** @param {string} name @param {ElementRecord | undefined} record */
function srlAttributeHover(name, record) {
  if (name === '*if') return '**`*if`** — renders this element when its expression is truthy.';
  if (name === '*else') return '**`*else`** — alternate for the preceding sibling carrying `*if`.';
  if (name === '*for') return '**`*for`** — iterates `item of items`; accepts `key:` and `index as` clauses.';
  if (name.startsWith('(') && name.endsWith(')')) return `**\`${name}\`** — typed DOM event binding; \`$event\` is in scope.`;
  const binding = srlBoundProperty(name);
  if (binding !== null && record?.properties.includes(binding) === true) {
    return `**\`${name}\`** — \`${record.className}.${binding}\` property binding.`;
  }
  if (name.startsWith('[?')) return `**\`${name}\`** — boolean attribute binding.`;
  if (name.startsWith('[')) return `**\`${name}\`** — attribute binding.`;
  return observedHover(name, record);
}

/** @param {string} name @param {ElementRecord | undefined} record */
function litAttributeHover(name, record) {
  if (name.startsWith('@')) {
    const event = record?.events.find((candidate) => candidate.name === name.slice(1));
    const from = event === undefined ? 'DOM event binding' : `\`${record?.className}\` event`;
    return `**\`${name}\`** — Lit ${from}; the substitution is the listener.`;
  }
  const binding = litBoundProperty(name);
  if (binding !== null) {
    return record?.properties.includes(binding) === true
      ? `**\`${name}\`** — \`${record.className}.${binding}\` property binding.`
      : `**\`${name}\`** — property binding.`;
  }
  if (name.startsWith('?')) return `**\`${name}\`** — boolean attribute binding.`;
  return observedHover(name, record);
}

/** @param {string} name @param {ElementRecord | undefined} record */
function observedHover(name, record) {
  if (record?.observedAttributes?.includes(name) === true) {
    return `**\`${name}\`** — observed by \`${record.className}\`.`;
  }
  return null;
}

/** @param {string} name The property an srl binding writes, or null when it binds nothing. */
function srlBoundProperty(name) {
  if (!name.startsWith('[.') || !name.endsWith(']')) return null;
  return camelCase(name.slice(2, -1));
}

/** @param {string} name The property a Lit binding writes, or null when it binds nothing. */
function litBoundProperty(name) {
  return name.startsWith('.') && name.length > 1 ? name.slice(1) : null;
}

/** @param {{ attributes: string[] } | undefined} native @param {ElementRecord | undefined} record */
function attributeNames(native, record) {
  return [
    ...new Set([...COMMON_ATTRIBUTES, ...(native?.attributes ?? []), ...(record?.observedAttributes ?? [])]),
  ];
}

/** @param {{ properties: string[] } | undefined} native @param {ElementRecord | undefined} record */
function propertyNames(native, record) {
  return [...new Set([...(native?.properties ?? []), ...(record?.properties ?? [])])];
}

/**
 * Lit grammar worth colouring, given that a JavaScript grammar paints the whole tagged
 * template as one string.
 *
 * Tag names and binding prefixes are the markup a reader scans for; attribute names and
 * text are left to the string colour so the two stay distinguishable.
 *
 * @param {TemplateSemantics | null} semantics
 */
function litHighlights(semantics) {
  if (semantics === null) return [];
  /** @type {Array<{ start: number, length: number, type: number }>} */
  const spans = semantics
    .tagSpans()
    .map((tag) => ({ start: tag.start, length: tag.end - tag.start, type: TOKEN_TYPES.class }));
  for (const attribute of semantics.attributeSpans()) {
    const type =
      attribute.name.startsWith('@')
        ? TOKEN_TYPES.event
        : attribute.name.startsWith('.') || attribute.name.startsWith('?')
          ? TOKEN_TYPES.property
          : undefined;
    if (type === undefined) continue;
    spans.push({ start: attribute.start, length: attribute.end - attribute.start, type });
  }
  return spans.sort((left, right) => left.start - right.start);
}

/**
 * srl grammar worth colouring beyond what native HTML highlighting already knows.
 *
 * @param {string} source
 * @param {Array<{ start: number, end: number }>} expressions
 */
function srlHighlights(source, expressions) {
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

/** @param {string} value */
function camelCase(value) {
  return value.replace(/-([a-z])/gu, (_all, character) => String(character).toUpperCase());
}

/** @param {string} value */
function kebabCase(value) {
  return value.replace(/[A-Z]/gu, (character) => `-${character.toLowerCase()}`);
}
