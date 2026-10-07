/**
 * Path admission, the one canonical form every module that compares paths reads.
 * ADR-0133.
 *
 * A path crosses several readers. The manifest admits it, the router matches it, the
 * remote host compares it to a grant, the browser sends it and a server routes it. A
 * reader that canonicalizes on its own reads some spellings differently from the
 * next, so a check passes on one path and the request reaches another. A path is
 * admitted only when every reader sees the same string. Anything left to normalize
 * is refused rather than repaired.
 *
 * The module imports nothing and touches no DOM, so Node tools load it by path.
 * Every export is internal, because applications compare paths through the modules
 * that use it.
 */

/** Parses root-relative text. A path that leaves this origin was written to. */
const BASE = 'https://path.invalid';

/**
 * An escaped separator or dot. A server that decodes before routing reads `..%2F` as
 * a parent segment the browser never resolved.
 */
const ENCODED = /%(?:2f|5c|2e)/iu;

/**
 * Admit a root-relative path written as text, such as a manifest URL, and return it.
 *
 * The text must already be what the URL parser gives back. `/api/../auth` is `/auth`
 * to a browser and something else to a string comparison, and `<` comes back as
 * `%3C`. A backslash is refused before parsing, because the parser reads it as `/`
 * and `/\host/x` names another origin.
 *
 * @param {string} text
 * @param {string} where Names the value in an error.
 * @param {{ query?: boolean }} [options] `query` admits a search part.
 * @returns {string}
 * @internal
 */
export function admitPath(text, where, options) {
  const got = JSON.stringify(text);
  if (text.includes('\\')) {
    throw new Error(
      `${where} must not contain a backslash, got ${got}. The URL parser reads it as a path ` +
        `separator, so "/\\host/x" is another origin wearing the shape of a path.`,
    );
  }
  if (!text.startsWith('/') || text.startsWith('//')) {
    throw new Error(
      `${where} must be a root-relative path beginning with one "/", got ${got}. ` +
        `"//host/x" names another origin.`,
    );
  }
  if (text.includes('#')) {
    throw new Error(
      `${where} must not contain a fragment, got ${got}. No reader sends one, so it is either ` +
        `a typo or an attempt to hide the rest of the value.`,
    );
  }

  const url = new URL(text, BASE);
  if (url.origin !== BASE) throw new Error(`${where} must be same-origin, got ${got}.`);
  if (options?.query !== true && text.includes('?')) {
    throw new Error(`${where} must not contain a query, got ${got}.`);
  }
  const normal = url.pathname + url.search;
  if (normal !== text) {
    throw new Error(
      `${where} must be written in its normal form, ${JSON.stringify(normal)}, got ${got}. ` +
        `Every reader of this path has to see the same string.`,
    );
  }
  admitPathname(url, where);
  return text;
}

/**
 * Admit the path a parsed URL carries, which is the path a request sends, and return
 * it.
 *
 * Parsing has resolved `.` and `..`. What it leaves are spellings a server routes
 * differently from a prefix check. An escaped separator or dot decodes into a
 * traversal, `..;` is a parent segment to a servlet container, and `/a//b` is `/a/b`
 * to the router and to a server that merges slashes.
 *
 * @param {URL} url
 * @param {string} where Names the value in an error.
 * @returns {string}
 * @internal
 */
export function admitPathname(url, where) {
  const path = url.pathname;
  const got = JSON.stringify(path);
  if (ENCODED.test(path)) {
    throw new Error(
      `${where} must not escape a separator or a dot, got ${got}. A server that decodes ` +
        `"%2F", "%5C" or "%2E" before routing reads a different path than the one checked.`,
    );
  }

  const segments = path.split('/').slice(1);
  for (const [index, segment] of segments.entries()) {
    if (segment === '' && index < segments.length - 1) {
      throw new Error(
        `${where} must not contain an empty segment, got ${got}. "/a//b" and "/a/b" are one ` +
          `path to some readers and two to others.`,
      );
    }
    const name = segment.split(';')[0];
    if (name === '.' || name === '..') {
      throw new Error(
        `${where} must not contain a dot segment, got ${got}. A servlet container reads ` +
          `"..;" as "..".`,
      );
    }
  }
  return path;
}

/**
 * Whether `path` is `prefix` or lies below it.
 *
 * Both must be admitted, so comparing strings compares paths. `/api/a/` holds
 * `/api/a/b` and not `/api/ab`, with or without the trailing slash on the prefix.
 *
 * @param {string} prefix
 * @param {string} path
 * @returns {boolean}
 * @internal
 */
export function within(prefix, path) {
  const directory = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return path === prefix || path.startsWith(directory);
}

/**
 * A `route` stays on the page's origin and an `external` destination leaves it.
 *
 * @typedef {{ kind: 'route' | 'external', url: URL }} Destination
 */

/**
 * Where an href leads from a page on `origin`.
 *
 * Any scheme but http and https is refused, because `javascript:` runs in the page
 * and `data:` or `blob:` load bytes nothing pinned. The URL travels whole, so no
 * caller rebuilds it from its pathname, where `//host/x` would parse as another
 * origin.
 *
 * @param {string} href
 * @param {string} origin
 * @returns {Destination}
 * @internal
 */
export function destination(href, origin) {
  const url = new URL(href, origin);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      `Navigation to ${JSON.stringify(href)} is refused. Only http and https URLs are ` +
        `destinations, because any other scheme can run script in the page or load bytes ` +
        `nothing pinned.`,
    );
  }
  return { kind: url.origin === origin ? 'route' : 'external', url };
}
