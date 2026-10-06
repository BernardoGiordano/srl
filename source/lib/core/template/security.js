/**
 * Sanitizes values that flow from template expressions into the DOM.
 *
 * Escaping only suffices in text nodes. URL, resource URL, HTML and style sinks each
 * have their own rules, and a value is sanitized right before lit writes it.
 *
 * The sink is chosen at compile time. `attributeSinkFor` and `propertySinkFor` return
 * the one sanitizer a binding needs, or `null` when it needs none. An assignment in an
 * event binding and an outlet's props meet their element only at runtime, so
 * `assignProperty` chooses the sink then. ADR-0128.
 *
 * The four `bypassSecurityTrust*` functions are the escape hatch. Their names are
 * noisy on purpose, so every use stands out in review next to the validation that
 * makes it safe.
 */

import {
  refusedContent,
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

/**
 * Set while the sanitizer parses its input or a reviewed bypass mints its value. Only
 * then does the policy return markup or a URL unchanged.
 */
let passThrough = false;

// lit-html and the template compiler create their own policies for framework markup.
// This one stays private to the sanitizer. Its createHTML runs the sanitizer, so every
// TrustedHTML it issues is sanitized markup or a reviewed bypass.
const nativePolicy = nativeFactory?.createPolicy('ui-test', {
  createHTML: (value) => (passThrough ? value : sanitizeHtml(value)),
  createScriptURL: (value) => {
    if (passThrough) return value;
    throw new Error('A resource URL needs bypassSecurityTrustResourceUrl() after application validation.');
  },
});

/**
 * Return `value` from the native policy unchanged, as a TrustedHTML under enforcement.
 *
 * @param {string} value
 * @returns {unknown}
 */
function unchangedHtml(value) {
  if (nativePolicy === undefined) return value;
  passThrough = true;
  try {
    return nativePolicy.createHTML(value);
  } finally {
    passThrough = false;
  }
}

/**
 * @param {string} value
 * @returns {unknown}
 */
function unchangedScriptUrl(value) {
  if (nativePolicy === undefined) return value;
  passThrough = true;
  try {
    return nativePolicy.createScriptURL(value);
  } finally {
    passThrough = false;
  }
}

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
  switch (refusedProperty(name, tag)) {
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
    case 'raw-text-content':
      throw new Error(`${where} writes the content of <${tag}>. ${refusedContent(tag) ?? ''}`);
    default:
      break;
  }
  return sinkFor(tag, name, where);
}

/**
 * Write `receiver[name]` through the sink a property binding to the same element would
 * use. The element's tag is read when the write happens, because an event binding's
 * assignment and an outlet's props only meet their element then. A receiver that is
 * neither an element nor a shadow root has no sink.
 *
 * Event properties stay writable here. A string written to one is inert, and a
 * function is the component's own code.
 *
 * @param {object} receiver
 * @param {string} name
 * @param {unknown} value
 * @param {string} where
 * @internal
 */
export function assignProperty(receiver, name, value, where) {
  /** @type {Record<string, unknown>} */ (receiver)[name] = assignedValue(receiver, name, value, where);
}

/**
 * @param {object} receiver
 * @param {string} name
 * @param {unknown} value
 * @param {string} where
 * @returns {unknown}
 */
function assignedValue(receiver, name, value, where) {
  /** @type {string} */
  let tag;
  if (receiver instanceof Element) tag = String(Reflect.get(Element.prototype, 'localName', receiver));
  else if (receiver instanceof ShadowRoot) tag = '';
  else return value;

  switch (refusedProperty(name, tag)) {
    case 'outer-html':
      throw new Error(`${where} assigns outerHTML, which replaces the element. Assign innerHTML instead.`);
    case 'forbidden-member':
      throw new Error(`${where} assigns forbidden property ${name}.`);
    case 'raw-text-content':
      throw new Error(`${where} writes the content of <${tag}>. ${refusedContent(tag) ?? ''}`);
    default:
      break;
  }
  const sink = sinkFor(tag, name, where);
  return sink === null ? value : sink(value);
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
  if (trusted !== null) return unchangedHtml(trusted.unwrap(HTML));
  // Under Trusted Types the policy runs the sanitizer itself.
  const source = stringValue(value, where);
  return nativePolicy === undefined ? sanitizeHtml(source) : nativePolicy.createHTML(source);
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
  return unchangedScriptUrl(trusted.unwrap(RESOURCE_URL));
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

const ACTIVE_STYLE = /(?:(?:url|src|image|(?:-webkit-)?image-set)\s*\(|@import\b|expression\s*\(|(?:-moz-)?binding\s*:|behavior\s*:|\\|\/\*)/iu;

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

// Form controls are left out. A `<form>` exposes each control by name, and sanitized
// markup has no business collecting input.
const ALLOWED_ELEMENTS = new Set(
  `a abbr address article aside b bdi bdo blockquote br caption cite code col colgroup data
   dd del details dfn dialog div dl dt em fieldset figcaption figure footer h1 h2 h3 h4 h5 h6
   header hgroup hr i img ins kbd label legend li main mark menu meter nav ol p picture pre
   progress q rp rt ruby s samp section slot small source span strong sub summary sup table
   tbody td tfoot th thead time tr track u ul var video wbr`
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

/**
 * `id` and `name` become named properties of `document` and `window`, so a sanitized
 * `<img name="createElement">` would replace `document.createElement`. The prefix keeps
 * every name the markup sets apart from the DOM's own.
 */
const NAMED_PREFIX = 'user-content-';

/** Dropped from inline styles, so sanitized markup can't lay a layer over the page. */
const PLACEMENT_PROPERTIES = ['position', 'z-index'];

/**
 * DOM accessors taken from the prototypes. A `<form>` exposes each control as a named
 * property, so `form.children` or `form.removeAttribute` can be an `<input>` the markup
 * chose. The sanitizer calls these instead, which keeps its reads out of the markup's
 * reach. They are read once, on first use, so the module still loads without a DOM.
 *
 * @typedef {{
 *   localName: (this: Element) => string,
 *   childNodes: (this: Node) => NodeListOf<ChildNode>,
 *   getAttributeNames: (this: Element) => string[],
 *   getAttribute: (this: Element, name: string) => string | null,
 *   setAttribute: (this: Element, name: string, value: string) => void,
 *   removeAttribute: (this: Element, name: string) => void,
 *   remove: (this: Element) => void,
 *   replaceWith: (this: Element, ...nodes: Node[]) => void,
 * }} DomAccess
 */

/** @type {DomAccess | undefined} */
let dom;

/** @returns {DomAccess} */
function domAccess() {
  if (dom === undefined) {
    const element = Element.prototype;
    dom = {
      localName: own(element, 'localName'),
      childNodes: own(Node.prototype, 'childNodes'),
      getAttributeNames: own(element, 'getAttributeNames'),
      getAttribute: own(element, 'getAttribute'),
      setAttribute: own(element, 'setAttribute'),
      removeAttribute: own(element, 'removeAttribute'),
      remove: own(element, 'remove'),
      replaceWith: own(element, 'replaceWith'),
    };
  }
  return dom;
}

/**
 * A prototype's own getter or method, as a function to call with an explicit `this`.
 *
 * @template {Function} T
 * @param {object} prototype
 * @param {string} name
 * @returns {T}
 */
function own(prototype, name) {
  const descriptor = /** @type {{ get?: unknown, value?: unknown } | undefined} */ (
    Object.getOwnPropertyDescriptor(prototype, name)
  );
  const found = descriptor?.get ?? descriptor?.value;
  if (typeof found !== 'function') throw new Error(`The DOM has no ${name} on its prototype.`);
  return /** @type {T} */ (found);
}

/** @param {string} source @returns {string} */
function sanitizeHtml(source) {
  const template = document.createElement('template');
  template.innerHTML = /** @type {string} */ (unchangedHtml(source));
  const access = domAccess();
  // A NodeIterator, because it stays valid when the node it stands on is removed.
  const walk = document.createNodeIterator(template.content, NodeFilter.SHOW_ELEMENT);
  for (let node = walk.nextNode(); node !== null; node = walk.nextNode()) {
    sanitizeElement(/** @type {Element} */ (node), access);
  }
  return template.innerHTML;
}

/**
 * Sanitize one element. The walk reaches its children afterwards, including the ones
 * an unwrap moves into its place.
 *
 * @param {Element} element
 * @param {DomAccess} access
 */
function sanitizeElement(element, access) {
  const tag = access.localName.call(element);
  if (BLOCKED_ELEMENTS.has(tag)) {
    access.remove.call(element);
    return;
  }
  if (!ALLOWED_ELEMENTS.has(tag)) {
    access.replaceWith.call(element, ...access.childNodes.call(element));
    return;
  }
  for (const name of access.getAttributeNames.call(element)) {
    sanitizeAttribute(element, tag, name, access);
  }
}

/**
 * @param {Element} element
 * @param {string} tag
 * @param {string} name
 * @param {DomAccess} access
 */
function sanitizeAttribute(element, tag, name, access) {
  const value = access.getAttribute.call(element, name) ?? '';
  const lower = name.toLowerCase();
  if (lower.startsWith('on') || lower === 'srcset' || RESOURCE_URL_SINKS.has(`${tag}:${lower}`)) {
    access.removeAttribute.call(element, name);
    return;
  }
  if (lower === 'style') {
    const safe = sanitizeInlineStyle(value);
    if (safe === null) access.removeAttribute.call(element, name);
    else access.setAttribute.call(element, name, safe);
    return;
  }
  if (lower === 'id' || lower === 'name') {
    if (value !== '' && !value.startsWith(NAMED_PREFIX)) {
      access.setAttribute.call(element, name, `${NAMED_PREFIX}${value}`);
    }
    return;
  }
  if (URL_ATTRIBUTES.has(lower)) {
    access.setAttribute.call(element, name, sanitizeUrl(value));
    return;
  }
  if (!ALLOWED_ATTRIBUTES.has(lower) && !lower.startsWith('aria-') && !lower.startsWith('data-')) {
    access.removeAttribute.call(element, name);
  }
}

/** @type {CSSStyleDeclaration | undefined} */
let scratchStyle;

/**
 * The style sanitizer's rules, plus no placement. The browser parses the declarations,
 * so a property can't hide from the removal behind odd spacing or case.
 *
 * @param {string} value
 * @returns {string | null}
 */
function sanitizeInlineStyle(value) {
  if (sanitizeStyle(value) === null) return null;
  scratchStyle ??= document.createElement('div').style;
  scratchStyle.cssText = value;
  for (const property of PLACEMENT_PROPERTIES) scratchStyle.removeProperty(property);
  const kept = scratchStyle.cssText;
  return kept === '' ? null : kept;
}
