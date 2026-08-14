/**
 * The one synchronous persistence boundary for non-auth UI preferences.
 *
 * UI state is tiny and must be available before first render, so `localStorage`
 * fits better than IndexedDB. Storage stays injectable — a memory store, an
 * encrypted wrapper, a synchronously hydrated backend cache — and each owner/id
 * pair gets its own versioned key to avoid whole-map races.
 *
 * Every non-auth preference crosses here: table columns, filter values, sidebar
 * collapse, the theme, the locale. Nothing else in the library or the shared
 * collection calls `localStorage`, and `tools/checks/verify-deps.mjs` fails the
 * build when something does. Auth state is deliberately outside. ADR-0015.
 *
 * ONE FAILURE POLICY, FOR EVERY CALLER, so none of them writes its own fallback:
 *
 *  - A read that cannot produce current state returns `undefined`: storage
 *    missing or throwing, no value, malformed JSON, a value that is not an
 *    envelope, a schema version with no `migrate`, or a `migrate` that throws or
 *    declines. Rendering must never depend on storage having worked.
 *  - A write that cannot store returns `false`: storage missing or throwing, quota
 *    exceeded, or state that is not JSON-serialisable.
 *
 * Nothing throws for a storage reason. It throws only for a programming error in
 * the caller's key — an empty owner, id or prefix, or a schema version that is not
 * a positive integer — which is wrong in every environment.
 */

/**
 * @import { KeyValueStorage, LegacyKeyOptions, PreferenceLoadOptions,
 *   PreferencesConfig } from '@core/preferences/types.js'
 */

// The prefix keeps the name this module had, because it is written into every
// key already in a user's browser. Renaming it would read as "no preferences
// saved" on the first load after an upgrade.
const DEFAULT_PREFIX = 'ui.component-state';

/** @type {KeyValueStorage | undefined} */
let configuredStorage;
let prefix = DEFAULT_PREFIX;

/**
 * Change storage backend or key prefix. Calling with no args restores defaults.
 *
 * @param {PreferencesConfig} [config]
 */
export function configurePreferences(config = {}) {
  configuredStorage = config.storage;
  prefix = normalizePart(config.prefix ?? DEFAULT_PREFIX, 'prefix');
}

/**
 * Load one owner's stored preference. Invalid JSON, invalid envelopes, and
 * unavailable storage behave like missing state; rendering never fails.
 *
 * @template T
 * @param {string} owner
 * @param {string} id
 * @param {PreferenceLoadOptions<T>} [options]
 * @returns {T | undefined}
 */
export function loadPreference(owner, id, options = {}) {
  const schemaVersion = validVersion(options.schemaVersion ?? 1);
  /** @type {unknown} */
  let parsed;
  try {
    const raw = storage()?.getItem(preferenceKey(owner, id));
    if (raw === null || raw === undefined) return undefined;
    parsed = /** @type {unknown} */ (JSON.parse(raw));
  } catch {
    return undefined;
  }

  if (!isEnvelope(parsed)) return undefined;
  if (parsed.schemaVersion === schemaVersion) return /** @type {T} */ (parsed.state);
  if (options.migrate === undefined) return undefined;

  try {
    return options.migrate(parsed.state, parsed.schemaVersion);
  } catch {
    return undefined;
  }
}

/**
 * Persist one owner's preference. Returns false when storage is blocked,
 * full, absent, or state is not JSON-serializable.
 *
 * @param {string} owner
 * @param {string} id
 * @param {unknown} state
 * @param {{ schemaVersion?: number }} [options]
 * @returns {boolean}
 */
export function savePreference(owner, id, state, options = {}) {
  const schemaVersion = validVersion(options.schemaVersion ?? 1);
  try {
    const target = storage();
    if (target === undefined) return false;
    target.setItem(
      preferenceKey(owner, id),
      JSON.stringify({ schemaVersion, savedAt: Date.now(), state }),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove one owner's stored preference.
 *
 * @param {string} owner
 * @param {string} id
 * @returns {boolean}
 */
export function removePreference(owner, id) {
  try {
    const target = storage();
    if (target === undefined) return false;
    target.removeItem(preferenceKey(owner, id));
    return true;
  } catch {
    return false;
  }
}

/**
 * Load one preference, adopting a value an earlier build wrote under a raw key.
 *
 * Theme and locale predate this module and each owned a bare `localStorage` slot.
 * Routing them through the same envelope as every other preference would have
 * silently reset both on the first load after upgrading, so the old value is read
 * once, validated by the caller, written as an envelope, and the old key removed.
 * The legacy key is removed whether or not its value was accepted: this is a
 * migration, not a permanent second lookup, and a value nothing accepts is a value
 * that will never be read again.
 *
 * `accept` belongs to the caller because only it knows what a valid stored value
 * is — a theme that is still registered, a locale still in the supported list — and
 * a migration that adopts a value the caller would reject is worse than none.
 *
 * @template T
 * @param {string} owner
 * @param {string} id
 * @param {string} legacyKey Raw storage key an earlier build wrote.
 * @param {LegacyKeyOptions<T>} options
 * @returns {T | undefined}
 */
export function migrateLegacyKey(owner, id, legacyKey, options) {
  const schemaVersion = validVersion(options.schemaVersion ?? 1);
  const current = /** @type {T | undefined} */ (
    loadPreference(owner, id, { schemaVersion })
  );

  /** @type {string | null} */
  let raw = null;
  try {
    const target = storage();
    raw = target?.getItem(legacyKey) ?? null;
    if (raw !== null) target?.removeItem(legacyKey);
  } catch {
    return current;
  }

  if (current !== undefined || raw === null) return current;

  /** @type {T | undefined} */
  let accepted;
  try {
    accepted = options.accept(raw);
  } catch {
    return undefined;
  }
  if (accepted === undefined) return undefined;

  savePreference(owner, id, accepted, { schemaVersion });
  return accepted;
}

/**
 * A storage adapter that keeps values for as long as the page lives.
 *
 * The second real implementation of `KeyValueStorage`, which is what makes the
 * injectable store a seam rather than a hypothetical one. A suite configures it so
 * cases cannot inherit each other's preferences or leave any behind in the browser,
 * and an application embedded where storage is blocked by policy can configure it
 * to get working preferences that simply do not outlive the tab.
 *
 * @returns {KeyValueStorage}
 */
export function createMemoryStorage() {
  /** @type {Map<string, string>} */
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

/** @param {string} owner @param {string} id */
export function preferenceKey(owner, id) {
  return `${prefix}:${encodeURIComponent(normalizePart(owner, 'owner'))}:${encodeURIComponent(
    normalizePart(id, 'id'),
  )}`;
}

/** @returns {KeyValueStorage | undefined} */
function storage() {
  if (configuredStorage !== undefined) return configuredStorage;
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** @param {string} value @param {string} field */
function normalizePart(value, field) {
  const normalized = value.trim();
  if (normalized === '') throw new Error(`[preferences] ${field} must not be empty.`);
  return normalized;
}

/** @param {number} value */
function validVersion(value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('[preferences] schemaVersion must be a positive integer.');
  }
  return value;
}

/** @param {unknown} value @returns {value is { schemaVersion: number, state: unknown }} */
function isEnvelope(value) {
  if (value === null || typeof value !== 'object') return false;
  const candidate = /** @type {Record<string, unknown>} */ (value);
  return (
    Number.isInteger(candidate.schemaVersion) &&
    /** @type {number} */ (candidate.schemaVersion) > 0 &&
    Object.hasOwn(candidate, 'state')
  );
}
