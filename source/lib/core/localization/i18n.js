/**
 * Runtime internationalization that switches language without a reload.
 *
 * It rests on two signals. `t()` reads the message table, so a template that calls it
 * is subscribed, and a new table re-renders exactly those components.
 *
 * A bundle is a URL pattern containing `{locale}` that resolves to JSON. Registered
 * bundles merge, so a micro-frontend can ship its own translations. Keys are flattened
 * to dotted paths on load.
 *
 * `Intl` handles plurals and formatting. Pass `count`, and `Intl.PluralRules` picks the
 * category. `num`, `cur`, `dt` and `rel` wrap the formatters, cached per locale and
 * reactive like `t`.
 */

import { batch, computed, signal } from '@core/foundation/reactive.js';
import { registerTemplateGlobals } from '@core/template/expression.js';
import { migrateLegacyKey, savePreference } from '@core/preferences/persistence.js';

/** @import { I18nConfig, MessageTable } from '@core/localization/types.js' */

/**
 * The chosen locale is stored through the preference module, so swapping the store
 * covers it too. `ui.locale` is an older key, adopted once so saved choices survive the
 * upgrade.
 */
const STATE_COMPONENT = 'locale';
const STATE_ID = 'ui.locale';
const LOCALE_STATE_VERSION = 1;

/** Locales written right to left. */
const RTL = new Set(['ar', 'fa', 'he', 'ur']);

/* ── State ─────────────────────────────────────────────────────────────── */

/** @type {I18nConfig} */
let config = {
  defaultLocale: 'en',
  supportedLocales: ['en'],
  bundles: [],
};

/** URL patterns contributing messages, in registration order. */
/** @type {string[]} */
const patterns = [];

/** Tables by resolved bundle URL, so each bundle is fetched once. */
/** @type {Map<string, MessageTable>} */
const fetched = new Map();

/** The active locale. Read it to react to changes; write through `setLocale`. */
export const locale = signal('en');

/** Merged message table for the active locale. Read by `t`. */
/** @type {import('@core/foundation/types.js').Signal<MessageTable>} */
const messages = signal(emptyTable());

/**
 * Read-only view of the message table.
 *
 * Components don't need it, because calling `t()` subscribes them. It serves a remote
 * built on another stack, which gets `onChange` callbacks. Watching `locale` alone
 * would miss a bundle merged at the same locale.
 *
 * @type {import('@core/foundation/types.js').ReadonlySignal<MessageTable>}
 */
export const messageTable = computed(() => messages.value);

/** True while `setLocale` is fetching bundles. Bind it to disable a picker. */
export const isLoadingLocale = signal(false);

/** Text direction for the active locale, for `dir` bindings. */
export const direction = computed(() => (RTL.has(baseLanguage(locale.value)) ? 'rtl' : 'ltr'));

/** The locales this application offers, with their names in their own language. */
export const availableLocales = computed(() =>
  config.supportedLocales.map((code) => ({ code, label: localeLabel(code) })),
);

/* ── Configuration ─────────────────────────────────────────────────────── */

/**
 * Apply the manifest's `i18n` block and load the starting locale.
 *
 * Startup awaits this before the first render, so no component flashes untranslated
 * text.
 *
 * @param {I18nConfig} next
 * @returns {Promise<void>}
 */
export async function configureI18n(next) {
  config = next;
  for (const pattern of next.bundles) {
    if (!patterns.includes(pattern)) patterns.push(pattern);
  }
  await setLocale(preferredLocale());
}

/**
 * Add a message bundle. It is safe after startup, and the merged table re-renders
 * whatever is on screen.
 *
 * @param {string} pattern URL containing `{locale}`.
 * @returns {Promise<void>}
 */
export async function registerMessages(pattern) {
  if (patterns.includes(pattern)) return;
  patterns.push(pattern);
  messages.value = await mergeFor(locale.value);
}

/**
 * Switch locale.
 *
 * Both signals are written in one `batch`, so components re-render once with a matching
 * table and locale.
 *
 * @param {string} requested BCP-47 tag. Negotiated against the supported list.
 * @returns {Promise<void>}
 */
export async function setLocale(requested) {
  const next = negotiate(requested);
  if (next === locale.value && Object.keys(messages.value).length > 0) return;

  isLoadingLocale.value = true;
  try {
    const table = await mergeFor(next);
    batch(() => {
      messages.value = table;
      locale.value = next;
    });

    // A save that fails, as in private browsing, returns `false` and doesn't break
    // startup.
    savePreference(STATE_COMPONENT, STATE_ID, next, {
      schemaVersion: LOCALE_STATE_VERSION,
    });

    const root = document.documentElement;
    root.lang = next;
    root.dir = direction.value;
  } finally {
    isLoadingLocale.value = false;
  }
}

/* ── Translation ───────────────────────────────────────────────────────── */

/**
 * Translate a key.
 *
 * Reading `messages.value` subscribes the calling template to the message table.
 *
 * A missing key renders as the key itself and doesn't throw, so the defect is visible
 * without breaking the component.
 *
 * @param {string} key
 * @param {Readonly<Record<string, unknown>>} [params]
 * @returns {string}
 */
export function t(key, params) {
  const table = messages.value;

  let pattern = table[key];

  const count = params?.count;
  if (typeof count === 'number') {
    const category = pluralRules(locale.value).select(count);
    pattern = table[`${key}.${category}`] ?? table[`${key}.other`] ?? pattern;
  }

  // A key with no message renders as itself.
  if (pattern === undefined) return key;
  return params === undefined ? pattern : interpolate(pattern, params);
}

/**
 * Hoisted, because a regex literal is a new object per evaluation and this runs for
 * every parameterized `t()`. `replace` resets `lastIndex`, so sharing it is safe.
 */
const PLACEHOLDER = /\{(\w+)\}/gu;

/**
 * Fill `{name}` placeholders. Numbers and dates are formatted for the active locale, so
 * `{count}` reads `1.234` in Italian.
 *
 * @param {string} pattern
 * @param {Readonly<Record<string, unknown>>} params
 * @returns {string}
 */
function interpolate(pattern, params) {
  return pattern.replace(PLACEHOLDER, (all, name) => {
    if (typeof name !== 'string' || !(name in params)) return all;
    const value = params[name];
    if (typeof value === 'number') return num(value);
    if (value instanceof Date) return dt(value);
    if (value === null || value === undefined) return '';
    // Objects, functions and symbols render nothing, which beats `[object Object]`.
    if (typeof value === 'string') return value;
    if (typeof value === 'boolean' || typeof value === 'bigint') return String(value);
    return '';
  });
}

/* ── Formatters ────────────────────────────────────────────────────────── */

/**
 * Cached `Intl` formatters. Building one per render is measurable in a list, so they
 * are kept per locale and options.
 *
 * @type {Map<string, Intl.NumberFormat | Intl.DateTimeFormat | Intl.RelativeTimeFormat | Intl.PluralRules>}
 */
const formatters = new Map();

/**
 * Look up or build a formatter by a key the caller composes.
 *
 * Callers with fixed options pass a fixed key, so they skip stringifying an options
 * object on every call. Only `num` and `dt` with custom options stringify them.
 *
 * @template {Intl.NumberFormat | Intl.DateTimeFormat | Intl.RelativeTimeFormat | Intl.PluralRules} T
 * @param {string} key
 * @param {() => T} build
 * @returns {T}
 */
function memoize(key, build) {
  const existing = formatters.get(key);
  if (existing !== undefined) return /** @type {T} */ (existing);
  const built = build();
  formatters.set(key, built);
  return built;
}

/**
 * Format a number for the active locale.
 *
 * @param {number} value
 * @param {Intl.NumberFormatOptions} [options]
 * @returns {string}
 */
export function num(value, options) {
  const tag = locale.value;
  const key = options === undefined ? `number|${tag}` : `number|${tag}|${JSON.stringify(options)}`;
  return memoize(key, () => new Intl.NumberFormat(tag, options)).format(value);
}

/**
 * Format money. The currency comes from the data, never from the locale, so an Italian
 * user sees a dollar price in dollars.
 *
 * @param {number} value
 * @param {string} currency ISO 4217, e.g. `EUR`.
 * @returns {string}
 */
export function cur(value, currency) {
  const tag = locale.value;
  return memoize(
    `number|${tag}|currency=${currency}`,
    () => new Intl.NumberFormat(tag, { style: 'currency', currency }),
  ).format(value);
}

/** What `dt` formats with when the caller names no options. */
const DEFAULT_DATE_OPTIONS = /** @type {Intl.DateTimeFormatOptions} */ ({ dateStyle: 'medium' });

/**
 * Format a date or timestamp.
 *
 * @param {Date | number | string} value
 * @param {Intl.DateTimeFormatOptions} [options]
 * @returns {string}
 */
export function dt(value, options) {
  const tag = locale.value;
  const key = options === undefined ? `date|${tag}` : `date|${tag}|${JSON.stringify(options)}`;
  return memoize(key, () => new Intl.DateTimeFormat(tag, options ?? DEFAULT_DATE_OPTIONS)).format(
    value instanceof Date ? value : new Date(value),
  );
}

/** The one options object `rel` uses. */
const RELATIVE_OPTIONS = /** @type {Intl.RelativeTimeFormatOptions} */ ({ numeric: 'auto' });

/**
 * Format a relative time, e.g. `3 days ago`.
 *
 * @param {number} value Signed; negative is in the past.
 * @param {Intl.RelativeTimeFormatUnit} unit
 * @returns {string}
 */
export function rel(value, unit) {
  const tag = locale.value;
  return memoize(
    `relative|${tag}`,
    () => new Intl.RelativeTimeFormat(tag, RELATIVE_OPTIONS),
  ).format(value, unit);
}

/**
 * @param {string} tag
 * @returns {Intl.PluralRules}
 */
function pluralRules(tag) {
  return memoize(`plural|${tag}`, () => new Intl.PluralRules(tag));
}

/* ── Loading ───────────────────────────────────────────────────────────── */

/**
 * Build the merged table for a locale.
 *
 * Bundles load in parallel and merge in registration order, so a later remote can
 * override a shell key. Fallback locales merge underneath, so a partial translation
 * falls back key by key.
 *
 * @param {string} tag
 * @returns {Promise<MessageTable>}
 */
async function mergeFor(tag) {
  const chain = fallbackChain(tag);
  const tables = await Promise.all(
    chain.flatMap((candidate) => patterns.map((pattern) => load(pattern, candidate))),
  );

  // Reverse, so earlier chain entries win. The requested locale beats its base
  // language, which beats the default.
  const merged = emptyTable();
  for (const table of tables.reverse()) Object.assign(merged, table);
  return merged;
}

/**
 * @param {string} tag
 * @returns {string[]}
 */
function fallbackChain(tag) {
  const chain = [tag];
  const base = baseLanguage(tag);
  if (base !== tag) chain.push(base);
  if (!chain.includes(config.defaultLocale)) chain.push(config.defaultLocale);
  return chain;
}

/**
 * Load one bundle for a locale. A 404 or a failure yields an empty table, because a
 * missing translation file is normal during translation work.
 *
 * The URL the pattern resolves to is the bundle's identity and cache key. `bundleFiles`
 * maps it to the hash-named file a build emitted.
 *
 * @param {string} pattern
 * @param {string} tag
 * @returns {Promise<MessageTable>}
 */
async function load(pattern, tag) {
  const url = pattern.replace('{locale}', tag);
  const cached = fetched.get(url);
  if (cached !== undefined) return cached;

  let table = emptyTable();
  try {
    const response = await fetch(config.bundleFiles?.[url] ?? url);
    if (response.ok) {
      table = flatten(/** @type {unknown} */ (await response.json()));
    }
  } catch {
    // Fall back to the locales already merged. An untranslated page beats a blank one.
  }

  fetched.set(url, table);
  return table;
}

/**
 * Flatten nested JSON to dotted keys, once at load.
 *
 * Keys that start with `$` are translator notes, such as `$comment`, and are skipped
 * here and by `verify-deps.mjs` alike.
 *
 * @param {unknown} value
 * @returns {MessageTable}
 */
function flatten(value) {
  const flat = emptyTable();

  /**
   * @param {unknown} node
   * @param {string} prefix
   */
  const walk = (node, prefix) => {
    if (typeof node !== 'object' || node === null) return;
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith('$')) continue;
      const path = prefix === '' ? key : `${prefix}.${key}`;
      if (typeof child === 'string') flat[path] = child;
      else if (typeof child === 'number') flat[path] = String(child);
      else if (typeof child === 'object' && child !== null) walk(child, path);
    }
  };

  walk(value, '');
  return flat;
}

/**
 * An empty message table with no prototype. Keys come from bundles and lookups may come
 * from data, so `t('constructor')` must find nothing and a `__proto__` entry must stay
 * a plain key.
 *
 * @returns {MessageTable}
 */
function emptyTable() {
  /** @type {unknown} */
  const table = Object.create(null);
  return /** @type {MessageTable} */ (table);
}

/* ── Negotiation ───────────────────────────────────────────────────────── */

/**
 * Pick the starting locale, from `?lang=`, then the stored choice, then the browser's
 * languages, then the default.
 *
 * `?lang=` wins, so a link can pin a language for a screenshot without changing the
 * user's saved choice.
 *
 * @returns {string}
 */
function preferredLocale() {
  const requested = new URLSearchParams(location.search).get('lang');
  if (requested !== null && requested !== '') return requested;

  // Unavailable storage, bad data and unsupported locales all come back undefined.
  const stored = migrateLegacyKey(STATE_COMPONENT, STATE_ID, STATE_ID, {
    schemaVersion: LOCALE_STATE_VERSION,
    accept: (raw) => (raw !== '' && isSupported(raw) ? raw : undefined),
  });
  if (stored !== undefined && stored !== '') return stored;

  for (const candidate of navigator.languages) {
    if (isSupported(candidate)) return candidate;
  }
  return config.defaultLocale;
}

/**
 * @param {string} requested
 * @returns {string}
 */
function negotiate(requested) {
  if (isSupported(requested)) return exactOrBase(requested);
  const base = baseLanguage(requested);
  if (isSupported(base)) return exactOrBase(base);
  return config.defaultLocale;
}

/**
 * @param {string} tag
 * @returns {boolean}
 */
function isSupported(tag) {
  return (
    config.supportedLocales.includes(tag) ||
    config.supportedLocales.includes(baseLanguage(tag))
  );
}

/**
 * Resolve `it-IT` to `it` when only `it` is supported, so the bundle URL, the stored
 * value and `lang` agree.
 *
 * @param {string} tag
 * @returns {string}
 */
function exactOrBase(tag) {
  if (config.supportedLocales.includes(tag)) return tag;
  return baseLanguage(tag);
}

/**
 * @param {string} tag
 * @returns {string}
 */
function baseLanguage(tag) {
  return tag.split('-')[0] ?? tag;
}

/**
 * @param {string} code
 * @returns {string}
 */
function localeLabel(code) {
  try {
    // Name each language in itself, so someone looking for Italian finds "italiano".
    const names = new Intl.DisplayNames([code], { type: 'language' });
    return names.of(code) ?? code;
  } catch {
    return code;
  }
}

/* ── Template globals ──────────────────────────────────────────────────── */

/**
 * Expose the helpers above to every template by bare name, like Angular's built-in
 * pipes, so no component injects anything to translate.
 */
registerTemplateGlobals({
  t,
  num,
  cur,
  dt,
  rel,
  locale,
  direction,
  isLoadingLocale,
  availableLocales,
  setLocale,
});
