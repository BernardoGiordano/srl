/**
 * Security contexts for values that cross from a template expression into DOM.
 *
 * Escaping text is sufficient only in a text node. URL, executable-resource,
 * HTML and style sinks each have different rules, so a value bound into one is
 * sanitized immediately before Lit writes it.
 *
 * *Which* sink a binding writes into is settled once, while the template is
 * compiled: the element and the attribute name are both fixed by then, and
 * `attributeSinkFor`/`propertySinkFor` hand the compiler the single sanitizer
 * that binding will ever need — or `null`, when the binding is in no security
 * context and needs none.
 *
 * The four `bypassSecurityTrust*` functions are the public escape hatch. Their
 * deliberately noisy names are part of the API: every use should stand out in a
 * review and should sit next to the validation that makes the bypass safe.
 */

import {
  refusedProperty,
  RESOURCE_URL_SINKS,
  securityContextFor,
  URL_ATTRIBUTES,
} from '@core/template/dialect.js';

/** @import { SecurityContext, TrustedHtml, TrustedResourceUrl, TrustedStyle, TrustedUrl } from '@core/template/types.js' */

const TRUSTED_VALUE = Symbol('ui-test trusted value');

// Which sink is which is dialect.js's answer; these are the labels a developer
// reads in an error message, and the tags a trusted value is stamped with.
const HTML = 'HTML';
const STYLE = 'Style';
const URL_CONTEXT = 'URL';
const RESOURCE_URL = 'Resource URL';

/**
 * The browser's Trusted Types interfaces are not in TypeScript's DOM library.
 * Keep the small surface used here structural instead of adding ambient globals.
 *
 * @typedef {{
 *   createHTML(value: string): unknown,
 *   createScriptURL(value: string): unknown,
 * }} NativePolicy
 * @typedef {{
 *   createPolicy(name: string, rules: {
 *     createHTML(value: string): string,
 *     createScriptURL(value: string): string,
 *   }): NativePolicy,
 * }} NativePolicyFactory
 */

const nativeFactory = /** @type {{ trustedTypes?: NativePolicyFactory }} */ (
  /** @type {unknown} */ (globalThis)
).trustedTypes;

// `lit-html` and the runtime template compiler create separate policies for
// their static/framework-owned markup. This policy stays private to the
// sanitizer and covers only values assigned to HTML/resource binding sinks.
const nativePolicy = nativeFactory?.createPolicy('ui-test', {
  createHTML: (value) => value,
  createScriptURL: (value) => value,
});

class TrustedValue {
  /** @type {typeof HTML | typeof STYLE | typeof URL_CONTEXT | typeof RESOURCE_URL} */
  #context;
  #value;

  /**
   * @param {typeof HTML | typeof STYLE | typeof URL_CONTEXT | typeof RESOURCE_URL} context
   * @param {string} value
   */
  constructor(context, value) {
    this.#context = context;
    this.#value = value;
    Object.defineProperty(this, TRUSTED_VALUE, { value: true });
    Object.freeze(this);
  }

  /** @param {string} expected */
  unwrap(expected) {
    if (this.#context !== expected) {
      throw new Error(
        `A value trusted for ${this.#context} was used in a ${expected} security context.`,
      );
    }
    return this.#value;
  }

  toString() {
    throw new Error(
      `A trusted ${this.#context} value cannot be converted to a string. ` +
        `Pass it directly to the matching template binding.`,
    );
  }
}

/**
 * Bypass HTML sanitization. The caller is responsible for proving `value` safe.
 * @param {string} value
 * @returns {TrustedHtml}
 */
export function bypassSecurityTrustHtml(value) {
  return /** @type {TrustedHtml} */ (/** @type {unknown} */ (new TrustedValue(HTML, value)));
}

/**
 * Bypass style sanitization. The caller is responsible for proving `value` safe.
 * @param {string} value
 * @returns {TrustedStyle}
 */
export function bypassSecurityTrustStyle(value) {
  return /** @type {TrustedStyle} */ (/** @type {unknown} */ (new TrustedValue(STYLE, value)));
}

/**
 * Bypass ordinary URL sanitization. This is not sufficient for an executable
 * resource sink such as iframe.src or link.href.
 * @param {string} value
 * @returns {TrustedUrl}
 */
export function bypassSecurityTrustUrl(value) {
  return /** @type {TrustedUrl} */ (/** @type {unknown} */ (new TrustedValue(URL_CONTEXT, value)));
}

/**
 * Trust a URL that loads an executable or embeddable resource. This is the
 * narrowest and most security-sensitive bypass; prefer fixed template literals.
 * @param {string} value
 * @returns {TrustedResourceUrl}
 */
export function bypassSecurityTrustResourceUrl(value) {
  return /** @type {TrustedResourceUrl} */ (
    /** @type {unknown} */ (new TrustedValue(RESOURCE_URL, value))
  );
}

/**
 * Assign framework-owned template source to a parser sink in a way that remains
 * compatible with `require-trusted-types-for 'script'`.
 *
 * @param {HTMLTemplateElement} template
 * @param {string} source
 */
function setTemplateSource(template, source) {
  template.innerHTML = /** @type {string} */ (
    /** @type {unknown} */ (nativePolicy?.createHTML(source) ?? source)
  );
}

/**
 * Resolve the sink an attribute binding writes into.
 *
 * Every input to this decision is fixed when the binding is compiled — the
 * element, the attribute name — so the compiler asks once and keeps the answer
 * instead of re-deriving it per evaluation. `null` means the attribute lands in
 * no security context and the value needs no sanitizer at all.
 *
 * @param {string} tag
 * @param {string} name
 * @param {string} where
 * @returns {Sanitizer | null}
 */
export function attributeSinkFor(tag, name, where) {
  if (name.toLowerCase().startsWith('on')) {
    throw new Error(`${where} targets an inline event attribute. Use an (event) binding.`);
  }
  return sinkFor(tag, name, where);
}

/**
 * Resolve the sink a property binding writes into, and refuse outright the DOM
 * assignments whose lifecycle or code-execution semantics cannot be made safe.
 *
 * Those refusals used to be raised on every evaluation, and a compile-time call
 * with a `null` value existed alongside them so that a dangerous target failed
 * even when the binding never rendered. Resolving the sink at compile time is
 * that call, so the pair collapses into one.
 *
 * @param {string} tag
 * @param {string} name camelCased property name.
 * @param {string} where
 * @returns {Sanitizer | null}
 */
export function propertySinkFor(tag, name, where) {
  switch (refusedProperty(name)) {
    case 'event-property':
      throw new Error(
        `${where} targets event property ${name}. Use an (event) binding; event properties are refused.`,
      );
    case 'outer-html':
      throw new Error(
        `${where} targets outerHTML, which would replace Lit's own node. Use an innerHTML binding.`,
      );
    case 'forbidden-member':
      throw new Error(`${where} targets forbidden property ${name}.`);
    default:
      break;
  }
  return sinkFor(tag, name, where);
}

/**
 * The dialect decides which sink a name is; this binds that answer to the one
 * sanitizer it selects, together with the `where` its errors quote.
 *
 * @param {string} tag
 * @param {string} name
 * @param {string} where
 * @returns {Sanitizer | null}
 */
function sinkFor(tag, name, where) {
  const context = securityContextFor(tag, name);
  if (context === undefined) return null;
  const sanitize = SANITIZERS[context];
  return (value) => sanitize(value, where);
}

/**
 * One sanitizer per context, selected by name rather than by a chain of
 * comparisons the evaluator would walk again on every render.
 *
 * @typedef {(value: unknown) => unknown | null} Sanitizer
 * @typedef {(value: unknown, where: string) => unknown | null} ContextSanitizer
 */

/** @type {Readonly<Record<SecurityContext, ContextSanitizer>>} */
const SANITIZERS = {
  html: sanitizeForHtml,
  style: sanitizeForStyle,
  url: sanitizeForUrl,
  urlSet: sanitizeForUrlSet,
  resourceUrl: sanitizeForResourceUrl,
};

/**
 * A nullish value means "remove this attribute" in every context, which is why
 * each sanitizer answers `null` before looking at anything else.
 *
 * @param {unknown} value
 * @param {string} where
 * @returns {unknown | null}
 */
function sanitizeForHtml(value, where) {
  if (value === null || value === undefined) return null;
  const trusted = asTrustedValue(value);
  if (trusted === null) return nativeHtml(sanitizeHtml(stringValue(value, where)));
  return nativeHtml(trusted.unwrap(HTML));
}

/** @param {unknown} value @param {string} where @returns {unknown | null} */
function sanitizeForStyle(value, where) {
  if (value === null || value === undefined) return null;
  const trusted = asTrustedValue(value);
  return trusted === null ? sanitizeStyle(stringValue(value, where)) : trusted.unwrap(STYLE);
}

/** @param {unknown} value @param {string} where @returns {unknown | null} */
function sanitizeForUrl(value, where) {
  if (value === null || value === undefined) return null;
  const trusted = asTrustedValue(value);
  return trusted === null ? sanitizeUrl(stringValue(value, where)) : trusted.unwrap(URL_CONTEXT);
}

/** @param {unknown} value @param {string} where @returns {unknown | null} */
function sanitizeForUrlSet(value, where) {
  if (value === null || value === undefined) return null;
  const trusted = asTrustedValue(value);
  // A URL set is stamped with the ordinary URL trust: `srcset` carries the same
  // values `src` does, so a separate stamp would be a distinction without one.
  return trusted === null ? sanitizeUrlSet(stringValue(value, where)) : trusted.unwrap(URL_CONTEXT);
}

/** @param {unknown} value @param {string} where @returns {unknown | null} */
function sanitizeForResourceUrl(value, where) {
  if (value === null || value === undefined) return null;
  const trusted = asTrustedValue(value);
  if (trusted === null) {
    throw new Error(
      `${where} is an executable resource URL and requires ` +
        `bypassSecurityTrustResourceUrl() after application validation.`,
    );
  }
  return nativeScriptUrl(trusted.unwrap(RESOURCE_URL));
}

/** @param {unknown} value @param {string} where @returns {string} */
function stringValue(value, where) {
  if (typeof value === 'string') return value;
  if (value instanceof URL) return value.href;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  throw new Error(`${where} requires a string, URL, or matching trusted value.`);
}

/** @param {unknown} value @returns {TrustedValue | null} */
function asTrustedValue(value) {
  if (typeof value !== 'object' || value === null) return null;
  if (!(TRUSTED_VALUE in value) || !(value instanceof TrustedValue)) return null;
  return value;
}

/** @param {string} value @returns {unknown} */
function nativeHtml(value) {
  return nativePolicy?.createHTML(value) ?? value;
}

/** @param {string} value @returns {unknown} */
function nativeScriptUrl(value) {
  return nativePolicy?.createScriptURL(value) ?? value;
}

// Schemes that browsers treat as ordinary navigation/fetch destinations. Data
// URLs are limited to non-SVG media; `data:text/html` and `data:image/svg+xml`
// can carry active content in embedding contexts.
const SAFE_SCHEMES = new Set(['blob', 'ftp', 'http', 'https', 'mailto', 'sms', 'tel']);
const SAFE_DATA_URL = /^data:(?:audio\/(?:aac|flac|midi|mpeg|mp4|ogg|wav|webm)|image\/(?:avif|bmp|gif|jpeg|jpg|png|webp)|video\/(?:mp4|mpeg|ogg|webm));base64,[a-z0-9+/]+=*$/iu;
const SCHEME = /^([a-z][a-z0-9+.-]*):/iu;

/** @param {string} value @returns {string} */
function sanitizeUrl(value) {
  const trimmed = value.trim();
  // Remove ASCII controls only for scheme detection. Browsers ignore these in
  // surprising positions, so `java\nscript:` must not evade the protocol check.
  const comparable = withoutAsciiControls(trimmed);
  const scheme = SCHEME.exec(comparable)?.[1]?.toLowerCase();
  if (scheme === undefined || SAFE_SCHEMES.has(scheme)) return trimmed;
  if (scheme === 'data' && SAFE_DATA_URL.test(comparable)) return trimmed;
  return `unsafe:${trimmed}`;
}

const URL_SET_SCHEME = /(?:^|[\s,])([a-z][a-z0-9+.-]*):/giu;
const SAFE_URL_SET_SCHEMES = new Set(['blob', 'ftp', 'http', 'https']);

/** @param {string} value @returns {string} */
function sanitizeUrlSet(value) {
  const trimmed = value.trim();
  const comparable = withoutAsciiControls(trimmed);
  for (const match of comparable.matchAll(URL_SET_SCHEME)) {
    const scheme = match[1]?.toLowerCase();
    if (scheme !== undefined && !SAFE_URL_SET_SCHEMES.has(scheme)) return `unsafe:${trimmed}`;
  }
  return trimmed;
}

/** @param {string} value @returns {string} */
function withoutAsciiControls(value) {
  return [...value]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 32 && (code < 127 || code > 159);
    })
    .join('');
}

const ACTIVE_STYLE = /(?:url\s*\(|@import\b|expression\s*\(|(?:-moz-)?binding\s*:|behavior\s*:|\\)/iu;

/** @param {string} value @returns {string | null} */
function sanitizeStyle(value) {
  // CSS escape and comment rules make block-list decoding deceptively complex.
  // Dynamic declarations stay deliberately narrow; a reviewed TrustedStyle is
  // required for URLs, imports or escapes.
  return ACTIVE_STYLE.test(value) ? null : value;
}

const BLOCKED_ELEMENTS = new Set([
  'base',
  'embed',
  'frame',
  'frameset',
  'iframe',
  'link',
  'meta',
  'object',
  'script',
  'style',
]);

const ALLOWED_ELEMENTS = new Set(
  `a abbr address article aside b bdi bdo blockquote br button caption cite code col colgroup
   data dd del details dfn dialog div dl dt em fieldset figcaption figure footer form h1 h2 h3 h4
   h5 h6 header hgroup hr i img input ins kbd label legend li main mark menu meter nav ol optgroup
   option output p picture pre progress q rp rt ruby s samp section select slot small source span
   strong sub summary sup table tbody td textarea tfoot th thead time tr track u ul var video wbr`
    .split(/\s+/u)
    .filter(Boolean),
);

const ALLOWED_ATTRIBUTES = new Set(
  `abbr accept accept-charset accesskey align alt autocomplete autofocus axis bgcolor border
   cellpadding cellspacing checked class clear color cols colspan compact controls coords datetime
   dir disabled download enctype face for headers height hidden hreflang hspace id inert ismap label
   lang loop max maxlength media method min minlength multiple muted name open placeholder preload
   readonly rel required reversed role rows rowspan selected shape size span start step summary tabindex
   target title translate type usemap valign value vspace width wrap`
    .split(/\s+/u)
    .filter(Boolean),
);

/** @param {string} source @returns {string} */
function sanitizeHtml(source) {
  const template = document.createElement('template');
  setTemplateSource(template, source);
  sanitizeChildren(template.content);
  return template.innerHTML;
}

/** @param {DocumentFragment | Element} parent */
function sanitizeChildren(parent) {
  for (const child of [...parent.children]) sanitizeElement(child);
}

/** @param {Element} element */
function sanitizeElement(element) {
  const tag = element.localName;
  if (BLOCKED_ELEMENTS.has(tag)) {
    element.remove();
    return;
  }

  sanitizeChildren(element);
  if (!ALLOWED_ELEMENTS.has(tag)) {
    element.replaceWith(...element.childNodes);
    return;
  }

  for (const attribute of [...element.attributes]) {
    const name = attribute.name.toLowerCase();
    if (name.startsWith('on') || name === 'srcset') {
      element.removeAttribute(attribute.name);
      continue;
    }
    if (name === 'style') {
      const safe = sanitizeStyle(attribute.value);
      if (safe === null) element.removeAttribute(attribute.name);
      else element.setAttribute(attribute.name, safe);
      continue;
    }
    if (RESOURCE_URL_SINKS.has(`${tag}:${name}`)) {
      element.removeAttribute(attribute.name);
      continue;
    }
    if (URL_ATTRIBUTES.has(name)) {
      element.setAttribute(attribute.name, sanitizeUrl(attribute.value));
      continue;
    }
    if (
      !ALLOWED_ATTRIBUTES.has(name) &&
      !name.startsWith('aria-') &&
      !name.startsWith('data-')
    ) {
      element.removeAttribute(attribute.name);
    }
  }
}
