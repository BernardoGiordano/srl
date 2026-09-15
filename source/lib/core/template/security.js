/**
 * Sanitizes values that flow from template expressions into the DOM.
 *
 * Escaping only suffices in text nodes. URL, resource URL, HTML and style sinks each
 * have their own rules, and a value is sanitized right before lit writes it.
 *
 * The sink is chosen at compile time. `attributeSinkFor` and `propertySinkFor` return
 * the one sanitizer a binding needs, or `null` when it needs none.
 *
 * The four `bypassSecurityTrust*` functions are the escape hatch. Their names are
 * noisy on purpose, so every use stands out in review next to the validation that
 * makes it safe.
 */

import {
  refusedProperty,
  RESOURCE_URL_SINKS,
  securityContextFor,
  URL_ATTRIBUTES,
} from '@core/template/dialect.js';

/** @import { SecurityContext, TrustedHtml, TrustedResourceUrl, TrustedStyle, TrustedUrl } from '@core/template/types.js' */

const TRUSTED_VALUE = Symbol('ui-test trusted value');

// Labels for error messages and trusted-value stamps. dialect.js decides which sink
// is which.
const HTML = 'HTML';
const STYLE = 'Style';
const URL_CONTEXT = 'URL';
const RESOURCE_URL = 'Resource URL';

/**
 * TypeScript's DOM library lacks the Trusted Types interfaces, so the small surface
 * used here is typed structurally.
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

// lit-html and the template compiler create their own policies for framework markup.
// This one stays private to the sanitizer and covers HTML and resource URL sinks.
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
 * Bypass HTML sanitization. The caller must prove `value` is safe.
 * @param {string} value
 * @returns {TrustedHtml}
 */
export function bypassSecurityTrustHtml(value) {
  return /** @type {TrustedHtml} */ (/** @type {unknown} */ (new TrustedValue(HTML, value)));
}

/**
 * Bypass style sanitization. The caller must prove `value` is safe.
 * @param {string} value
 * @returns {TrustedStyle}
 */
export function bypassSecurityTrustStyle(value) {
  return /** @type {TrustedStyle} */ (/** @type {unknown} */ (new TrustedValue(STYLE, value)));
}

/**
 * Bypass URL sanitization. It isn't enough for an executable resource sink such as
 * `iframe.src` or `link.href`.
 * @param {string} value
 * @returns {TrustedUrl}
 */
export function bypassSecurityTrustUrl(value) {
  return /** @type {TrustedUrl} */ (/** @type {unknown} */ (new TrustedValue(URL_CONTEXT, value)));
}

/**
 * Trust a URL that loads an executable or embeddable resource. This is the most
 * sensitive bypass, so prefer fixed URLs written in the template.
 * @param {string} value
 * @returns {TrustedResourceUrl}
 */
export function bypassSecurityTrustResourceUrl(value) {
  return /** @type {TrustedResourceUrl} */ (
    /** @type {unknown} */ (new TrustedValue(RESOURCE_URL, value))
  );
}

/**
 * Assign framework-owned template source to a parser sink under
 * `require-trusted-types-for 'script'`.
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
 * Resolve the sink an attribute binding writes into. `null` means no security
 * context and no sanitizer.
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
 * Resolve the sink a property binding writes into, and refuse properties that can't
 * be made safe. Refusals happen at compile time, even if the binding never renders.
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
 * Pair the dialect's context for a name with its sanitizer and the `where` its errors
 * quote.
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
 * One sanitizer per context, looked up by name.
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
 * A nullish value removes the attribute in every context, so each sanitizer checks
 * for it first.
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
  // `srcset` carries the same values as `src`, so it accepts URL trust.
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

// Schemes browsers treat as ordinary navigation or fetch targets. Data URLs are
// limited to non-SVG media, because `data:text/html` and `data:image/svg+xml` can
// carry active content.
const SAFE_SCHEMES = new Set(['blob', 'ftp', 'http', 'https', 'mailto', 'sms', 'tel']);
const SAFE_DATA_URL = /^data:(?:audio\/(?:aac|flac|midi|mpeg|mp4|ogg|wav|webm)|image\/(?:avif|bmp|gif|jpeg|jpg|png|webp)|video\/(?:mp4|mpeg|ogg|webm));base64,[a-z0-9+/]+=*$/iu;
const SCHEME = /^([a-z][a-z0-9+.-]*):/iu;

/** @param {string} value @returns {string} */
function sanitizeUrl(value) {
  const trimmed = value.trim();
  // Strip ASCII controls for scheme detection only, so `java\nscript:` can't slip
  // past the check.
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
  // CSS escapes and comments make block lists hard to get right, so dynamic styles
  // stay narrow. URLs, imports and escapes need a reviewed TrustedStyle.
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
