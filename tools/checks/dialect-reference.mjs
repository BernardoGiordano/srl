/**
 * The generated blocks of docs/reference/template-dialect.md.
 *
 * The runtime compiler and the template checker read the dialect from
 * source/lib/core/template/dialect.js and expression-parser.js. This module is a third
 * reader, and it writes what the other two enforce. Tables in the dialect are printed
 * as they are. Rules that live in code, such as how a binding name is classified or
 * which expressions parse, are shown by running sample spellings through the dialect's
 * own functions. The samples and their labels are written here, and every verdict comes
 * from the dialect, so a changed rule changes the page.
 *
 * readme-check.mjs owns the page and the markers.
 */

import {
  BOOLEAN_ATTRIBUTES,
  classifyAttributeName,
  classifyBindingTarget,
  FOR_LOCALS,
  FORBIDDEN_MEMBERS,
  HTML_SINKS,
  parseFragmentHead,
  refusedProperty,
  RESOURCE_URL_SINKS,
  strictOperator,
  STYLE_SINKS,
  URL_ATTRIBUTES,
  URL_SET_SINKS,
  VOID_ELEMENTS,
} from '@srljs/core/lib/core/template/dialect.js';
import {
  BINARY_LEVELS,
  parseExpression,
  WORD_LITERALS,
} from '@srljs/core/lib/core/template/expression-parser.js';

import { table } from './generated.mjs';

/** @import { SecurityContext } from '@srljs/core/lib/core/template/types.js' */

/**
 * Attribute spellings, lowercase because the HTML parser lowercases them before the
 * dialect sees them.
 */
const BINDING_SAMPLES = [
  'title',
  '[href]',
  '[?open]',
  '[hidden]',
  '[.max-rows]',
  '(click)',
  '(value-change)',
  'onclick',
  '[onclick]',
  '[.onclick]',
  '[.constructor]',
  '[]',
  '[.]',
];

/** Fragment heads, as written inside `*fragment="…"`. */
const FRAGMENT_SAMPLES = [
  'cell(row)',
  'cell(row of rows, index)',
  'empty-state()',
  'cell(row, row)',
  'cell',
  'cell(row.id)',
];

/** Expression constructs, each with one example. */
const EXPRESSION_SAMPLES = [
  ['Member access', 'user.name'],
  ['Optional chaining', 'user?.name'],
  ['Index access', "row['name']"],
  ['Call', 'format(user.created)'],
  ['Arithmetic', 'price * quantity + 1'],
  ['Comparison', 'count >= 10'],
  ['Loose equality, compared strictly', "status == 'open'"],
  ['Logical operators', 'ready && !failed'],
  ['Nullish coalescing', "name ?? 'anonymous'"],
  ['Conditional', "open ? 'Hide' : 'Show'"],
  ['Array literal', '[first, second]'],
  ['Object literal', "{ id: row.id, 'aria-label': label }"],
  ['Signal reference', '&panel'],
  ['Assignment', 'selected = row'],
  ['Compound assignment', 'count += 1'],
  ['Increment', 'count++'],
  ['Arrow function', '(item) => item.id'],
  ['`new`', 'new Date()'],
  ['Template literal', '`Hello ${name}`'],
  ['Bitwise operator', 'flags | mask'],
  ['`typeof`', 'typeof value'],
  ['`in`', "'id' in row"],
  ['Unary plus', '+value'],
  ['Comma operator', 'first, second'],
  ['Spread', '[...items]'],
  ['Computed object key', '{ [key]: value }'],
  ['Shorthand object property', '{ id }'],
  ['Exponent or hex literal', '1e3'],
  ['Regular expression', '/^a/.test(name)'],
  ['Reserved member', 'user.constructor'],
];

/**
 * What the runtime does with a value in each context.
 *
 * @type {Record<SecurityContext, string>}
 */
const CONTEXT_EFFECT = {
  html: 'Active markup is removed. `bypassSecurityTrustHtml` skips that.',
  style: 'A value with `url(`, `@import`, `expression(` or a backslash is dropped. `bypassSecurityTrustStyle` skips that.',
  url: 'An active scheme such as `javascript:` gets an `unsafe:` prefix. `bypassSecurityTrustUrl` skips that.',
  urlSet: 'Every URL in the list is checked as a URL. `bypassSecurityTrustUrl` skips that.',
  resourceUrl: 'Refused unless the value comes from `bypassSecurityTrustResourceUrl`.',
};

/**
 * Why a property binding is refused, keyed by the tag `refusedProperty` returns.
 *
 * @type {Record<NonNullable<ReturnType<typeof refusedProperty>>, string>}
 */
const PROPERTY_REFUSAL = {
  'event-property': 'Refused. Bind the event in parentheses.',
  'outer-html': 'Refused, because it would replace the node Lit renders.',
  'forbidden-member': 'Refused, because the name is reserved.',
};

/** Prefix operators to try. The page lists the ones that parse. */
const UNARY_CANDIDATES = ['!', '-', '+', '~', '&'];

/**
 * A code span that survives backticks and table pipes in its content.
 *
 * @param {string} text
 * @returns {string}
 */
function code(text) {
  const fence = text.includes('`') ? '``' : '`';
  const padded = text.startsWith('`') || text.endsWith('`') ? ` ${text} ` : text;
  return `${fence}${padded.replaceAll('|', '\\|')}${fence}`;
}

/** @param {Iterable<string>} names @returns {string} */
function codeList(names) {
  return [...names]
    .sort()
    .map((name) => code(name))
    .join(', ');
}

/**
 * What the dialect makes of one attribute spelling.
 *
 * @param {string} written
 * @returns {string}
 */
function readBinding(written) {
  const outer = classifyAttributeName(written);
  switch (outer.kind) {
    case 'plain':
      return 'Static attribute. `{{ }}` inside the value interpolates.';
    case 'event':
      return `Listens for ${code(outer.event)}. \`$event\` is in scope.`;
    case 'inline-handler':
      return 'Refused. Bind the event in parentheses.';
    case 'binding':
      break;
    default:
      throw new Error(`No description for attribute kind ${JSON.stringify(outer)}.`);
  }

  const inner = classifyBindingTarget(outer.target);
  switch (inner.kind) {
    case 'attribute':
      return `Sets attribute ${code(inner.name)}.`;
    case 'boolean':
      return `Adds or removes attribute ${code(inner.name)}.`;
    case 'property': {
      const refusal = refusedProperty(inner.name);
      if (refusal === undefined) return `Sets property ${code(inner.name)}.`;
      return PROPERTY_REFUSAL[refusal];
    }
    case 'inline-handler':
      return 'Refused. Bind the event in parentheses.';
    case 'empty-attribute':
    case 'empty-property':
      return 'Refused, because the binding names nothing.';
    default:
      throw new Error(`No description for binding kind ${JSON.stringify(inner.kind)}.`);
  }
}

/** @param {string} head @returns {string} */
function readFragment(head) {
  const parsed = parseFragmentHead(head);
  if (parsed === undefined) return 'Refused.';
  const params = parsed.params.map((param) =>
    param.iterable === undefined ? code(param.name) : `${code(param.name)}, typed from ${code(param.iterable)}`,
  );
  return `Assigns property ${code(parsed.property)}. Parameters: ${params.length === 0 ? 'none' : params.join('; ')}.`;
}

/**
 * @param {string} source
 * @param {boolean} allowAssignment
 * @returns {string}
 */
function parses(source, allowAssignment) {
  try {
    parseExpression(source, 'the reference', { allowAssignment });
    return 'yes';
  } catch {
    return 'no';
  }
}

/** @returns {string} */
function sinks() {
  /** @type {Array<[SecurityContext, string]>} */
  const rows = [
    ['resourceUrl', [...RESOURCE_URL_SINKS].sort().map((pair) => code(pair.replace(':', ' '))).join(', ')],
    ['html', `${codeList(HTML_SINKS)}, on any element`],
    ['style', `${codeList(STYLE_SINKS)}, on any element`],
    ['urlSet', `${codeList(URL_SET_SINKS)}, on any element`],
    ['url', `${codeList(URL_ATTRIBUTES)}, on any element`],
  ];
  const described = new Set(Object.keys(CONTEXT_EFFECT));
  if (rows.length !== described.size || rows.some(([context]) => !described.has(context))) {
    throw new Error('Every security context needs exactly one row in the sink table.');
  }
  return table(
    ['Context', 'Names', 'What happens to the value'],
    rows.map(([context, names]) => [code(context), names, CONTEXT_EFFECT[context]]),
  );
}

/** @returns {string} */
function operators() {
  const unary = UNARY_CANDIDATES.filter((operator) => parses(`${operator}value`, false) === 'yes');
  const rows = [...BINARY_LEVELS].reverse().map((level, index) => [
    String(index + 1),
    [...level]
      .map((operator) =>
        strictOperator(operator) === operator
          ? code(operator)
          : `${code(operator)} (as ${code(strictOperator(operator))})`,
      )
      .join(', '),
  ]);
  return [
    table(['Binds', 'Binary operators'], rows),
    '',
    `Level 1 binds tightest. The prefix operators are ${codeList(unary)}, and they bind ` +
      'tighter than every binary operator. A conditional `a ? b : c` binds loosest. ' +
      '`&` passes a signal without reading it.',
    '',
    `The word literals are ${[...WORD_LITERALS.keys()].map((word) => code(word)).join(', ')}. ` +
      'Numbers are decimal, and strings take single or double quotes.',
  ].join('\n');
}

/**
 * Every generated block on the template reference page, keyed by marker name.
 *
 * @returns {Map<string, string>}
 */
export function dialectSections() {
  return new Map([
    [
      'dialect-bindings',
      table(
        ['Written', 'Meaning'],
        BINDING_SAMPLES.map((written) => [code(written), readBinding(written)]),
      ),
    ],
    [
      'dialect-boolean-attributes',
      `${codeList(BOOLEAN_ATTRIBUTES)}.`,
    ],
    [
      'dialect-loop-locals',
      table(
        ['Local', 'Type', 'Value'],
        FOR_LOCALS.map((local) => [code(local.name), code(local.type), local.meaning]),
      ),
    ],
    [
      'dialect-fragments',
      table(
        ['Head', 'Meaning'],
        FRAGMENT_SAMPLES.map((head) => [code(head), readFragment(head)]),
      ),
    ],
    ['dialect-operators', operators()],
    [
      'dialect-expressions',
      table(
        ['Construct', 'Example', 'In a binding', 'In an event binding'],
        EXPRESSION_SAMPLES.map(([label = '', example = '']) => [
          label,
          code(example),
          parses(example, false),
          parses(example, true),
        ]),
      ),
    ],
    ['dialect-members', `${codeList(FORBIDDEN_MEMBERS)}.`],
    ['dialect-sinks', sinks()],
    ['dialect-void-elements', `${codeList(VOID_ELEMENTS)}.`],
  ]);
}
