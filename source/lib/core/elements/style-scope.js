/**
 * Rewrites an Element's stylesheet so its rules reach only that Element.
 *
 * A styled Element's template stamps `data-ui-owner="<tag>"` on everything it
 * renders. Each rule is rewritten to require that stamp inside a host of that tag.
 *
 *     .title { color: red }
 *
 *     @layer components {
 *       @scope (app-card) to (:scope app-card) {
 *         .title:where([data-ui-owner="app-card"]) { color: red }
 *       }
 *     }
 *
 * The stamp keeps projected markup out. The scope makes `:host` answer for the
 * nearest instance. `:host` is also the only way to name outer context, as in
 * `[data-theme='dark'] :host .title`. ADR-0119.
 *
 * The rules sit in Tailwind's `components` layer, above preflight and below
 * utilities.
 *
 * The module uses no DOM, so the browser, the build and the project model produce
 * identical output.
 */

/** The attribute a styled Element's template stamps on every element it renders. */
export const OWNER_ATTRIBUTE = 'data-ui-owner';

/** Tailwind's layer name, so these rules follow Tailwind's layer order. */
const LAYER = 'components';

/** At-rules whose body is more rules, rewritten like the rules around them. */
const CONDITIONS = new Set(['media', 'supports', 'container', 'starting-style']);

/** Directives only Tailwind's compiler understands. */
const TAILWIND = new Set([
  'apply',
  'config',
  'custom-variant',
  'plugin',
  'reference',
  'source',
  'tailwind',
  'theme',
  'utility',
  'variant',
]);

/** At-rules that define a name every stylesheet in the document shares. */
const GLOBAL = new Set([
  'counter-style',
  'font-face',
  'font-feature-values',
  'font-palette-values',
  'keyframes',
  'page',
  'position-try',
  'property',
  'view-transition',
]);

/** Selectors that only mean something inside a shadow root. */
const SHADOW = /::slotted\(|::part\(|:host-context\(/iu;

/** The pseudo-elements CSS still accepts with a single colon. */
const LEGACY_PSEUDO_ELEMENT = /^:(?:before|after|first-line|first-letter)(?![\w-])/iu;

/**
 * A rule that can't be scoped, with its location.
 *
 * `reason` is the message without the location, for callers that report line and
 * column separately.
 *
 * @internal
 */
export class StylesheetScopeError extends Error {
  /**
   * @param {string} reason
   * @param {string} where
   * @param {string} source
   * @param {number} offset
   */
  constructor(reason, where, source, offset) {
    const before = source.slice(0, offset).split('\n');
    const line = before.length;
    const column = (before.at(-1)?.length ?? 0) + 1;
    super(`${where}:${String(line)}:${String(column)} ${reason}`);
    this.name = 'StylesheetScopeError';
    this.reason = reason;
    this.line = line;
    this.column = column;
  }
}

/**
 * Rewrite one Element's stylesheet so its rules apply only to that Element.
 *
 * Throws on anything it can't scope: Tailwind directives, `@import`, `@layer`,
 * document-global definitions such as `@keyframes`, and shadow-DOM selectors.
 *
 * @internal
 * @param {string} tag The Element's tag, which roots the scope and names the owner.
 * @param {string} source The stylesheet as authored.
 * @param {string} where A URL or path, for error messages.
 * @returns {string}
 */
export function scopeStylesheet(tag, source, where) {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]*)+$/u.test(tag)) {
    throw new Error(`${JSON.stringify(tag)} is not a custom element name, so it cannot own ${where}.`);
  }

  const text = withoutComments(source);
  /** @type {Context} */
  const context = { tag, where, source: text };
  const body = readItems(text, 0, text.length, 'sheet', context);
  if (body === '') return '';
  return `@layer ${LAYER}{@scope (${tag}) to (:scope ${tag}){${body}}}`;
}

/**
 * @typedef {{ tag: string, where: string, source: string }} Context
 */

/**
 * Read the rules and declarations between two offsets and write them back scoped.
 *
 * In `sheet` mode, the top level or a condition there, only rules may appear. In
 * `rule` mode, a style rule's body, declarations and nested rules may both appear.
 *
 * @param {string} text
 * @param {number} from
 * @param {number} to
 * @param {'sheet' | 'rule'} mode
 * @param {Context} context
 * @returns {string}
 */
function readItems(text, from, to, mode, context) {
  let output = '';
  let at = from;

  while (at < to) {
    while (at < to && /\s/u.test(text[at] ?? '')) at += 1;
    if (at >= to) break;

    const stop = scan(text, at, to, ';{}');
    const prelude = text.slice(at, stop === -1 ? to : stop).trim();
    const char = stop === -1 ? '' : text[stop];

    if (char === '}') refuse(context, 'has a `}` that closes nothing.', stop);

    if (char === ';' || char === '') {
      if (prelude.startsWith('@')) refuseAtRule(context, prelude, at);
      if (mode === 'sheet') {
        refuse(context, `has \`${prelude}\` outside any rule.`, at);
      }
      output += `${prelude};`;
      at = stop === -1 ? to : stop + 1;
      continue;
    }

    const close = blockEnd(text, stop, to);
    if (close === -1) refuse(context, `never closes the block opened by \`${prelude}\`.`, stop);

    if (prelude.startsWith('@')) {
      const name = atRuleName(prelude);
      if (!CONDITIONS.has(name)) refuseAtRule(context, prelude, at);
      output += `${prelude}{${readItems(text, stop + 1, close, mode, context)}}`;
    } else {
      if (prelude.startsWith('--')) {
        refuse(context, `gives the custom property \`${prelude}\` a block as its value.`, at);
      }
      const selector = scopeSelectorList(prelude, at, context);
      output += `${selector}{${readItems(text, stop + 1, close, 'rule', context)}}`;
    }
    at = close + 1;
  }

  return output;
}

/**
 * @param {Context} context
 * @param {string} prelude
 * @param {number} offset
 * @returns {never}
 */
function refuseAtRule(context, prelude, offset) {
  const name = atRuleName(prelude);
  if (TAILWIND.has(name)) {
    refuse(
      context,
      `uses \`@${name}\`, a Tailwind directive. The browser reads an Element's stylesheet as ` +
        'plain CSS during development; put utilities in the template instead.',
      offset,
    );
  }
  if (GLOBAL.has(name)) {
    refuse(
      context,
      `defines \`@${name}\`, whose name every stylesheet in the document shares. Define it ` +
        "in the application's stylesheet and use it from here.",
      offset,
    );
  }
  if (name === 'import' || name === 'layer') {
    refuse(
      context,
      `uses \`@${name}\`. An Element's rules sit in one layer this framework chooses, and ` +
        'another file cannot be scoped from here.',
      offset,
    );
  }
  refuse(context, `uses \`@${name}\`, which cannot be scoped to one Element.`, offset);
}

/**
 * @param {Context} context
 * @param {string} reason
 * @param {number} offset
 * @returns {never}
 */
function refuse(context, reason, offset) {
  throw new StylesheetScopeError(reason, context.where, context.source, offset);
}

/** @param {string} prelude */
function atRuleName(prelude) {
  return (/^@([\w-]+)/u.exec(prelude)?.[1] ?? '').toLowerCase();
}

/* ── Selectors ────────────────────────────────────────────────────────────── */

/**
 * Scope every selector in a list.
 *
 * @param {string} list
 * @param {number} offset
 * @param {Context} context
 * @returns {string}
 */
function scopeSelectorList(list, offset, context) {
  return splitList(list)
    .map((selector) => {
      if (selector === '') refuse(context, `has an empty selector in \`${list}\`.`, offset);
      if (SHADOW.test(selector)) {
        refuse(
          context,
          `uses \`${selector}\`, a shadow DOM selector. Components render into light DOM here; ` +
            'style the element directly, or the host with `:host`.',
          offset,
        );
      }
      return scopeSelector(withHost(selector), context.tag);
    })
    .join(',');
}

/**
 * Require the element one selector styles to be owned by `tag`.
 *
 * Only the subject, the compound after the last combinator, gets the filter. The
 * scope already keeps ancestors inside the host. A subject that is `:scope` or `&`
 * was filtered where it was named.
 *
 * @param {string} selector
 * @param {string} tag
 * @returns {string}
 */
function scopeSelector(selector, tag) {
  const start = subjectStart(selector);
  const subject = selector.slice(start);
  if (mentions(subject, ':scope') || mentions(subject, '&')) return selector;

  const insert = start + pseudoElementStart(subject);
  const filter = `:where([${OWNER_ATTRIBUTE}="${tag}"])`;
  return `${selector.slice(0, insert)}${filter}${selector.slice(insert)}`;
}

/**
 * Rewrite `:host` and `:host(<selector>)` as the scope root.
 *
 * @param {string} selector
 * @returns {string}
 */
function withHost(selector) {
  let output = '';
  for (let at = 0; at < selector.length; at += 1) {
    const char = selector[at] ?? '';
    const skip = skipOpaque(selector, at);
    if (skip !== at) {
      output += selector.slice(at, skip + 1);
      at = skip;
      continue;
    }
    if (selector.startsWith(':host', at) && !/[\w-]/u.test(selector[at + 5] ?? '')) {
      if (selector[at + 5] === '(') {
        const close = parenEnd(selector, at + 5);
        output += `:scope:is(${selector.slice(at + 6, close)})`;
        at = close;
      } else {
        output += ':scope';
        at += 4;
      }
      continue;
    }
    output += char;
  }
  return output;
}

/**
 * Where the last compound of a complex selector begins.
 *
 * @param {string} selector
 * @returns {number}
 */
function subjectStart(selector) {
  let start = 0;
  let depth = 0;
  for (let at = 0; at < selector.length; at += 1) {
    const char = selector[at] ?? '';
    const skip = skipOpaque(selector, at);
    if (skip !== at) {
      at = skip;
      continue;
    }
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (depth === 0 && /[\s>+~]/u.test(char)) start = at + 1;
  }
  return start;
}

/**
 * Where a compound's pseudo-element begins, or its length when it has none. The
 * filter goes before it, so `.title::before` styles an owned `.title`.
 *
 * @param {string} compound
 * @returns {number}
 */
function pseudoElementStart(compound) {
  let depth = 0;
  for (let at = 0; at < compound.length; at += 1) {
    const char = compound[at] ?? '';
    const skip = skipOpaque(compound, at);
    if (skip !== at) {
      at = skip;
      continue;
    }
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (depth === 0 && char === ':') {
      if (compound[at + 1] === ':' || LEGACY_PSEUDO_ELEMENT.test(compound.slice(at))) return at;
    }
  }
  return compound.length;
}

/**
 * Whether a token appears in a selector outside its strings and attribute brackets.
 *
 * @param {string} selector
 * @param {string} token
 * @returns {boolean}
 */
function mentions(selector, token) {
  for (let at = 0; at < selector.length; at += 1) {
    const skip = skipOpaque(selector, at);
    if (skip !== at) {
      at = skip;
      continue;
    }
    if (selector.startsWith(token, at)) return true;
  }
  return false;
}

/**
 * Split a selector list at its top-level commas.
 *
 * @param {string} list
 * @returns {string[]}
 */
function splitList(list) {
  /** @type {string[]} */
  const selectors = [];
  let depth = 0;
  let start = 0;
  for (let at = 0; at < list.length; at += 1) {
    const char = list[at] ?? '';
    const skip = skipOpaque(list, at);
    if (skip !== at) {
      at = skip;
      continue;
    }
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (depth === 0 && char === ',') {
      selectors.push(list.slice(start, at).trim());
      start = at + 1;
    }
  }
  selectors.push(list.slice(start).trim());
  return selectors;
}

/* ── Text ─────────────────────────────────────────────────────────────────── */

/**
 * The last index of an escape, string or attribute selector that starts at `at`, or
 * `at` when none starts there. Their contents aren't syntax.
 *
 * @param {string} text
 * @param {number} at
 * @returns {number}
 */
function skipOpaque(text, at) {
  const char = text[at];
  if (char === '\\') return at + 1;
  if (char === '"' || char === "'") return stringEnd(text, at, text.length);
  if (char === '[') {
    for (let inner = at + 1; inner < text.length; inner += 1) {
      const skip = skipOpaque(text, inner);
      if (skip !== inner) inner = skip;
      else if (text[inner] === ']') return inner;
    }
    return text.length - 1;
  }
  return at;
}

/**
 * The first of `stops` at nesting depth zero between two offsets, or -1.
 *
 * @param {string} text
 * @param {number} from
 * @param {number} to
 * @param {string} stops
 * @returns {number}
 */
function scan(text, from, to, stops) {
  let depth = 0;
  for (let at = from; at < to; at += 1) {
    const char = text[at] ?? '';
    const skip = skipOpaque(text, at);
    if (skip !== at) {
      at = skip;
      continue;
    }
    if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && stops.includes(char)) return at;
  }
  return -1;
}

/**
 * The `}` that closes the block opened at `open`, or -1.
 *
 * @param {string} text
 * @param {number} open
 * @param {number} to
 * @returns {number}
 */
function blockEnd(text, open, to) {
  let depth = 0;
  for (let at = open; at < to; at += 1) {
    const char = text[at];
    const skip = skipOpaque(text, at);
    if (skip !== at) {
      at = skip;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return at;
    }
  }
  return -1;
}

/**
 * @param {string} text
 * @param {number} open
 * @returns {number}
 */
function parenEnd(text, open) {
  let depth = 0;
  for (let at = open; at < text.length; at += 1) {
    const skip = skipOpaque(text, at);
    if (skip !== at) {
      at = skip;
      continue;
    }
    if (text[at] === '(') depth += 1;
    else if (text[at] === ')') {
      depth -= 1;
      if (depth === 0) return at;
    }
  }
  return text.length;
}

/**
 * @param {string} text
 * @param {number} open
 * @param {number} to
 * @returns {number}
 */
function stringEnd(text, open, to) {
  const quote = text[open];
  for (let at = open + 1; at < to; at += 1) {
    const char = text[at];
    if (char === '\\') at += 1;
    else if (char === quote || char === '\n') return at;
  }
  return to - 1;
}

/**
 * Replace comments with spaces, so braces inside them aren't syntax and offsets
 * still match the authored lines.
 *
 * @param {string} source
 * @returns {string}
 */
function withoutComments(source) {
  let output = '';
  for (let at = 0; at < source.length; at += 1) {
    const char = source[at] ?? '';
    if (char === '\\' || char === '"' || char === "'") {
      const end = char === '\\' ? at + 1 : stringEnd(source, at, source.length);
      output += source.slice(at, end + 1);
      at = end;
    } else if (char === '/' && source[at + 1] === '*') {
      const close = source.indexOf('*/', at + 2);
      const end = close === -1 ? source.length : close + 2;
      output += source.slice(at, end).replace(/[^\n]/gu, ' ');
      at = end - 1;
    } else {
      output += char;
    }
  }
  return output;
}
