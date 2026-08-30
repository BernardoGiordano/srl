/**
 * Internationalisation that changes at runtime, everywhere, without a reload.
 *
 * The whole mechanism is two signals. `t()` reads the message table, so any
 * component whose template calls it has subscribed to it, and assigning a new
 * table re-renders exactly those components. No locale in the URL, no per-locale
 * bundle, no re-bootstrapping, and no subscription in application code.
 *
 * A bundle is a URL pattern containing `{locale}`, resolved to JSON. Several may
 * be registered and are merged, which is what lets a micro-frontend ship its own
 * translations. Keys are flat and dotted after loading: a missing key is then one
 * lookup and one warning naming it, instead of a walk that has to report which
 * level of nesting went missing.
 *
 * `Intl` does plurals and formatting, so there is no library and no ICU parser.
 * Pass `count` and the category comes from `Intl.PluralRules` for the active
 * locale, which is why a language with four forms costs nothing extra. `num`,
 * `cur`, `dt` and `rel` wrap the four formatters, memoised per locale and
 * reactive for the same reason `t` is.
 */

import { batch, computed, signal } from '@core/foundation/reactive.js';
import { registerTemplateGlobals } from '@core/template/expression.js';
import { migrateLegacyKey, savePreference } from '@core/preferences/persistence.js';

/** @import { I18nConfig, MessageTable } from '@core/localization/types.js' */

/**
 * The chosen locale is a UI preference, so it is stored by the module that owns
 * them rather than in a bare `localStorage` slot of its own: an application that
 * swaps the store now swaps it for the language too. `ui.locale` is the key an
 * earlier build wrote, and it is adopted once as the preference id so that nobody's
 * chosen language resets on upgrade.
 */
const STATE_COMPONENT = 'locale';
const STATE_ID = 'ui.locale';
const LOCALE_STATE_VERSION = 1;

/** Locales written right to left. Enough to prove `dir` is handled. */
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

/** `pattern|locale` -> table, so a locale is fetched at most once. */
/** @type {Map<string, MessageTable>} */
const fetched = new Map();

/** The active locale. Read it to react to changes; write through `setLocale`. */
export const locale = signal('en');

/** Merged message table for the active locale. Read by `t`. */
/** @type {import('@core/foundation/types.js').Signal<MessageTable>} */
const messages = signal(/** @type {MessageTable} */ ({}));

/**
 * Read-only view of that table, for code that must react to translations
 * changing without being able to write them.
 *
 * A component never needs this: it calls `t()` inside a render effect and is
 * subscribed by that call. It exists for the one case that has no render effect
 * to hide inside — a micro-frontend built on a different stack, which is handed
 * `onChange` callbacks rather than signals. Watching `locale` alone would miss a
 * bundle being merged at a constant locale, which is exactly what happens when
 * another remote loads.
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
 * Awaited by main.js before the first render, for the same reason the session
 * restore is: a component that renders once against an empty message table and
 * then again against a full one flashes untranslated text, and there is no
 * reason to ship that when startup can simply be ordered correctly.
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
 * Contribute another message bundle. Safe to call after startup: a remote that
 * registers its own translations while it loads gets them merged into the active
 * table, which re-renders whatever is already on screen.
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
 * The two signals are written inside one `batch`, so components re-render once
 * with a consistent pair rather than twice, the second time against a table that
 * does not match the locale their formatters just used.
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

    // A locale that does not persist is a far smaller problem than a startup that
    // throws, and deciding that is the preference store's job rather than this one's:
    // private browsing and a storage-blocked embed both come back as `false` here.
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
 * Reading `messages.value` here is the entire reactivity story: every template
 * that calls `t` has, by that call, subscribed to the message table.
 *
 * A missing key renders as the key itself and warns once in development. It does
 * not throw: an untranslated string is a visible, self-describing defect, while a
 * thrown error takes down the component that was going to show it.
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

  // A key with no message renders as itself, which is visible in the page and in
  // `npm run verify`'s untranslated count.
  if (pattern === undefined) return key;
  return params === undefined ? pattern : interpolate(pattern, params);
}

/**
 * Hoisted, because a regex literal is a fresh `RegExp` on every evaluation, and
 * this one is evaluated once per parameterised `t()` — which in a table is once per
 * cell. `String.prototype.replace` resets `lastIndex` on a global regex itself, so
 * sharing one instance is safe.
 */
const PLACEHOLDER = /\{(\w+)\}/gu;

/**
 * `{name}` placeholders. Numbers and dates are formatted for the active locale
 * rather than stringified, so `{count}` in Italian reads `1.234` and not `1234`.
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
    // An object, a function or a symbol renders nothing: `[object Object]` inside a
    // sentence is worse than an obvious gap.
    if (typeof value === 'string') return value;
    if (typeof value === 'boolean' || typeof value === 'bigint') return String(value);
    return '';
  });
}

/* ── Formatters ────────────────────────────────────────────────────────── */

/**
 * `Intl` constructors are expensive enough that building one per render is
 * measurable in a list, and cheap enough to keep forever once built. Keyed by
 * locale plus the options, so a page using two date formats keeps both.
 *
 * @type {Map<string, Intl.NumberFormat | Intl.DateTimeFormat | Intl.RelativeTimeFormat | Intl.PluralRules>}
 */
const formatters = new Map();

/**
 * The cache key is composed by the caller, not derived from an options object
 * here.
 *
 * `JSON.stringify(options)` is the obvious way to key this and the expensive one:
 * the fixed-shape formatters — money, relative time, a date with no options —
 * would allocate an options object and stringify it on every call to look up a
 * formatter already built. A thousand-row table with three money cells a row paid
 * for three thousand of those. Only `num`/`dt` with caller-supplied options still
 * stringify, and there the options really are arbitrary.
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
 * Format an amount of money. Currency is a data property, never a locale one:
 * an Italian user looking at a dollar price must see dollars.
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

/** `rel` has one shape, so it has one options object. */
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
 * Bundles are fetched in parallel and merged in registration order, so a remote
 * registered later may override a shell key deliberately. The fallback locale is
 * merged underneath, which means a partially translated locale falls back key by
 * key rather than all at once.
 *
 * @param {string} tag
 * @returns {Promise<MessageTable>}
 */
async function mergeFor(tag) {
  const chain = fallbackChain(tag);
  const tables = await Promise.all(
    chain.flatMap((candidate) => patterns.map((pattern) => load(pattern, candidate))),
  );

  // Reduced in reverse so the *first* entries of the chain win: the requested
  // locale beats its base language, which beats the default locale.
  /** @type {MessageTable} */
  const merged = {};
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
 * A bundle that 404s resolves to an empty table rather than rejecting. A locale
 * for which one of several bundles has no file yet is a normal state during
 * translation work, and it must not take the application down.
 *
 * The URL the pattern resolves to is the bundle's identity — it is what the cache
 * is keyed on and what `registerMessages` deduplicates — while `bundleFiles` says
 * which file currently answers for it. A build hash-names its bundles so they can
 * be served immutable, and a hash cannot live in a pattern; nothing else here
 * changes, because the substitution is still the only thing that names a locale.
 *
 * @param {string} pattern
 * @param {string} tag
 * @returns {Promise<MessageTable>}
 */
async function load(pattern, tag) {
  const url = pattern.replace('{locale}', tag);
  const cached = fetched.get(url);
  if (cached !== undefined) return cached;

  /** @type {MessageTable} */
  let table = {};
  try {
    const response = await fetch(config.bundleFiles?.[url] ?? url);
    if (response.ok) {
      table = flatten(/** @type {unknown} */ (await response.json()));
    }
  } catch {
    // A locale that cannot be loaded falls back to the one already in the table:
    // an untranslated page beats a blank one.
  }

  fetched.set(url, table);
  return table;
}

/**
 * Accept nested JSON as well as flat, and flatten it to dotted keys. Translation
 * tools overwhelmingly produce nested files; the runtime wants flat lookups, and
 * doing this once at load is the cheapest place.
 *
 * A key beginning with `$` is a note to translators, not a message: JSON has no
 * comments, so bundles carry `$comment` entries, sometimes as an array of lines.
 * They are skipped here and by `verify-deps.mjs`, which is what lets that tool
 * claim it flattens exactly as the runtime does.
 *
 * @param {unknown} value
 * @returns {MessageTable}
 */
function flatten(value) {
  /** @type {MessageTable} */
  const flat = {};

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

/* ── Negotiation ───────────────────────────────────────────────────────── */

/**
 * Pick a starting locale: an explicit `?lang=`, then a stored choice, then the
 * browser's preference list, then the default.
 *
 * `?lang=` wins so a link can pin a language for a screenshot or a support call
 * without changing what the user has chosen.
 *
 * @returns {string}
 */
function preferredLocale() {
  const requested = new URLSearchParams(location.search).get('lang');
  if (requested !== null && requested !== '') return requested;

  // Storage unavailable, malformed, or holding a locale this build no longer
  // supports all arrive here as undefined, and fall through to the browser's list.
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
 * `it-IT` requested against a supported list containing only `it` resolves to
 * `it`, so the message URL, the stored value and the `lang` attribute all agree.
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
    // Named in its own language, which is what a language picker should show:
    // someone looking for Italian is looking for "italiano".
    const names = new Intl.DisplayNames([code], { type: 'language' });
    return names.of(code) ?? code;
  } catch {
    return code;
  }
}

/* ── Template globals ──────────────────────────────────────────────────── */

/**
 * Everything above, callable from any `.html` template by bare name. This is the
 * equivalent of Angular's `DatePipe` and friends being available without an
 * import, and it is why no component needs to inject anything to be translated.
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
