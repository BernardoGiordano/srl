/**
 * Minify one component template, and prove the minified bytes parse to the same
 * thing the source did.
 *
 * A template is authored HTML: indented to be read, commented to be understood.
 * The runtime compiler reads it with `innerHTML` and a tree walk that skips
 * comments outright, so every byte of that indentation and every comment is paid
 * for over the wire and thrown away on arrival. In this repository's own
 * applications it is a third of the markup.
 *
 * WHAT MAKES THIS SAFE, GIVEN THE INVARIANT IT BREAKS
 *
 * Development serves the authored bytes and production serves these, so the
 * "same compiler over the same bytes" property that made the optional bundle
 * behaviour-preserving (ADR-0042) no longer holds for the artifact build. What
 * replaces it is a proof carried out on every template, every build:
 * `templateShape` reduces source and output to the same token stream the
 * compiler cares about — elements, their attributes, and text with runs of
 * whitespace normalised — and `minifyTemplate` throws when the two disagree.
 * A transform that deletes a node, reorders one, drops an attribute, or eats the
 * one space between two words fails the build rather than the page. ADR-0070.
 *
 * WHAT IT DOES
 *
 *   - Drops comments, which the compiler skips anyway
 *     (`source/lib/core/template/template.js`, `COMMENT_NODE`).
 *   - Collapses each run of ASCII whitespace in text to one space. Conservative
 *     on purpose: a run is never removed, because `a<span> </span>b` and
 *     `a<span></span>b` are two different renderings and only the author knows
 *     which was meant.
 *   - Collapses whitespace in `class`, which is a token list.
 *   - Trims the template's own leading and trailing whitespace.
 *
 * WHAT IT LEAVES ALONE
 *
 * Everything inside an element whose whitespace is significant: `pre`,
 * `textarea`, `script`, `style`, and any element that says so in markup the build
 * can actually read — `style="white-space: pre-wrap"`, or a Tailwind
 * `whitespace-pre`, `whitespace-pre-line`, `whitespace-pre-wrap`,
 * `whitespace-break-spaces` class. Preservation inherits, so the whole subtree is
 * left verbatim, comments included.
 *
 * The one thing it cannot see is a stylesheet: an element made preformatted by a
 * class of the application's own, with no such token in it, would have its
 * literal whitespace collapsed. Both escape hatches above are markup the author
 * writes on the element, and `<pre>` is the one to reach for first.
 *
 * `{{ ... }}` bodies are lifted out before parsing and put back after, exactly as
 * the runtime compiler does and for the same reason: `{{ a < b }}` in text would
 * otherwise be parsed as a tag.
 *
 * parse5 owns HTML syntax here, as it does for `index.html` (ADR-0041). Its
 * normalisations — an implied `<tbody>`, lowercased attribute names, `selected`
 * becoming `selected=""` — are the ones a browser's own parser performs on the
 * same bytes, which is what makes a re-serialised tree a safe thing to ship.
 */

import { parseFragment, serialize } from 'parse5';

import { INTERPOLATION } from '@srljs/core/lib/core/template/dialect.js';

/**
 * The subset of a parse5 tree this module reads, spelled out for the same reason
 * `build.mjs` spells out its own: parse5 6 ships no declarations, and a structural
 * typedef is the honest description of what is touched.
 *
 * @typedef {{
 *   nodeName: string,
 *   tagName?: string,
 *   attrs?: Array<{ name: string, value: string }>,
 *   childNodes?: HtmlNode[],
 *   content?: HtmlNode,
 *   value?: string,
 * }} HtmlNode
 */

/**
 * ASCII whitespace, which is what HTML collapses. Deliberately not `\s`: that
 * matches U+00A0, and collapsing a non-breaking space would change the rendering
 * of every `&nbsp;` in the repository.
 */
const ASCII_WHITESPACE = /[\t\n\f\r ]+/gu;

/** Elements whose text content is theirs, byte for byte. */
const VERBATIM_ELEMENTS = new Set(['pre', 'textarea', 'script', 'style']);

/** A `class` token that makes whitespace significant, Tailwind's or arbitrary. */
const VERBATIM_CLASS = /^(?:whitespace-pre|whitespace-break-spaces)|white-space:\s*(?:pre|break-spaces)/u;

/** `white-space` in an inline style, set to a value that keeps whitespace. */
const VERBATIM_STYLE = /white-space\s*:\s*(?:pre|pre-wrap|pre-line|break-spaces)/u;

/** The placeholder an interpolation is parked in. Matches `template.js`. */
const PLACEHOLDER = /⟦(\d+)⟧/gu;

/**
 * Minify a template, or throw naming the first thing that changed.
 *
 * The verification is inside rather than beside, so no caller can take the bytes
 * without the proof that they are the same bytes.
 *
 * @param {string} source Authored template markup.
 * @returns {string} Markup the runtime compiler reads identically.
 */
export function minifyTemplate(source) {
  const { prepared, expressions } = liftInterpolations(source);
  const fragment = parseFragment(prepared);
  squeeze(fragment, false);
  const minified = restoreInterpolations(serialize(fragment), expressions).trim();

  const before = templateShape(source);
  const after = templateShape(minified);
  const drift = firstDifference(before, after);
  if (drift !== null) {
    throw new Error(
      `minified template is not equivalent to its source: ${drift}`,
    );
  }
  return minified;
}

/**
 * What the compiler will see, as a token stream: every element with its
 * attributes, and every text run with its whitespace normalised.
 *
 * The one thing this is not allowed to be is a description of the transform.
 * Adjacent text nodes are joined because the DOM renders them as one; runs of
 * whitespace are normalised because that is the change under test; a run that
 * existed still has to exist, which is what makes "collapse, never delete"
 * checkable. Anything else — an element, an attribute, a word — has to survive
 * byte for byte, and text inside a verbatim element has to survive exactly.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function templateShape(source) {
  const { prepared } = liftInterpolations(source);
  const tokens = shapeOf(parseFragment(prepared), false, []);
  // The template's own edges: `trim()` is part of the transform, so leading and
  // trailing whitespace at the top level is not a difference.
  while (tokens[0] === 'text: ') tokens.shift();
  while (tokens.at(-1) === 'text: ') tokens.pop();
  return tokens;
}

/**
 * @param {HtmlNode} node
 * @param {boolean} verbatim
 * @param {string[]} tokens
 * @returns {string[]}
 */
function shapeOf(node, verbatim, tokens) {
  let text = '';
  const flush = () => {
    if (text === '') return;
    const value = verbatim ? text : text.replace(ASCII_WHITESPACE, ' ');
    tokens.push(value.trim() === '' ? 'text: ' : `text:${value.trim()}`);
    text = '';
  };

  for (const child of node.childNodes ?? []) {
    if (child.nodeName === '#comment') continue;
    if (child.nodeName === '#text') {
      text += child.value ?? '';
      continue;
    }
    if (child.tagName === undefined) continue;
    flush();
    tokens.push(`<${child.tagName} ${describeAttributes(child)}>`);
    shapeOf(contentOf(child), verbatim || isVerbatim(child), tokens);
    tokens.push(`</${child.tagName}>`);
  }
  flush();
  return tokens;
}

/**
 * `class` is compared as a token list because collapsing it is the transform;
 * every other attribute is compared exactly.
 *
 * @param {HtmlNode} element
 * @returns {string}
 */
function describeAttributes(element) {
  return (element.attrs ?? [])
    .map(
      (attribute) =>
        `${attribute.name}=${
          attribute.name === 'class'
            ? attribute.value.replace(ASCII_WHITESPACE, ' ').trim()
            : attribute.value
        }`,
    )
    .sort()
    .join(' ');
}

/**
 * @param {string[]} before
 * @param {string[]} after
 * @returns {string | null}
 */
function firstDifference(before, after) {
  const length = Math.max(before.length, after.length);
  for (let index = 0; index < length; index += 1) {
    if (before[index] === after[index]) continue;
    return (
      `at node ${String(index)}, source has ${describeToken(before[index])} ` +
      `and the output has ${describeToken(after[index])}`
    );
  }
  return null;
}

/** @param {string | undefined} token */
function describeToken(token) {
  return token === undefined ? 'nothing' : JSON.stringify(token);
}

/**
 * Drop comments, collapse text and `class`, and recur. Mutates the tree, which is
 * private to one call of `minifyTemplate`.
 *
 * @param {HtmlNode} node
 * @param {boolean} verbatim
 */
function squeeze(node, verbatim) {
  /** @type {HtmlNode[]} */
  const kept = [];

  for (const child of node.childNodes ?? []) {
    if (child.nodeName === '#comment') {
      if (verbatim) kept.push(child);
      continue;
    }
    if (child.nodeName === '#text') {
      if (!verbatim) child.value = (child.value ?? '').replace(ASCII_WHITESPACE, ' ');
      // A dropped comment leaves the text either side of it adjacent, and two
      // adjacent text nodes are one run of text to the DOM. Joining them is what
      // stops `x <!-- note --> y` from collapsing to two spaces instead of one.
      const previous = kept.at(-1);
      if (previous?.nodeName === '#text' && !verbatim) {
        previous.value = `${previous.value ?? ''}${child.value ?? ''}`.replace(
          ASCII_WHITESPACE,
          ' ',
        );
        continue;
      }
      kept.push(child);
      continue;
    }
    if (child.tagName === undefined) {
      kept.push(child);
      continue;
    }
    for (const attribute of child.attrs ?? []) {
      if (attribute.name === 'class') {
        attribute.value = attribute.value.replace(ASCII_WHITESPACE, ' ').trim();
      }
    }
    squeeze(contentOf(child), verbatim || isVerbatim(child));
    kept.push(child);
  }

  node.childNodes = kept;
}

/**
 * Whether this element's whitespace is significant, by its own markup.
 *
 * @param {HtmlNode} element
 * @returns {boolean}
 */
function isVerbatim(element) {
  if (element.tagName !== undefined && VERBATIM_ELEMENTS.has(element.tagName)) return true;
  for (const attribute of element.attrs ?? []) {
    if (attribute.name === 'class') {
      const tokens = attribute.value.split(ASCII_WHITESPACE);
      if (tokens.some((token) => VERBATIM_CLASS.test(token))) return true;
    }
    if (attribute.name === 'style' && VERBATIM_STYLE.test(attribute.value)) return true;
  }
  return false;
}

/**
 * A `<template>` keeps its children in `content`, and the serializer reads them
 * from there, so the transform has to as well.
 *
 * @param {HtmlNode} element
 * @returns {HtmlNode}
 */
function contentOf(element) {
  return element.tagName === 'template' && element.content !== undefined
    ? element.content
    : element;
}

/**
 * Park every `{{ ... }}` body in a placeholder before the HTML parser sees it.
 *
 * The same pre-pass the runtime compiler runs, for the same reason: `{{ a < b }}`
 * in text content would be parsed as the start of a tag named `b`, and the
 * expression would be silently mangled into markup.
 *
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

/**
 * @param {string} text
 * @param {string[]} expressions
 * @returns {string}
 */
function restoreInterpolations(text, expressions) {
  return text.replace(PLACEHOLDER, (all, index) => {
    const body = expressions[Number(index)];
    return body === undefined ? all : `{{${body}}}`;
  });
}
