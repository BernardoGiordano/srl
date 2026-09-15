/**
 * The synchronous storage boundary for non-auth UI preferences. ADR-0015.
 *
 * Preferences are small and must be ready before the first render, so they use
 * `localStorage`. The store is injectable, and each owner and id pair gets its own
 * versioned key. Table columns, filters, sidebar state, theme and locale all go through
 * here. Nothing else in the library or the collection calls `localStorage`, and
 * `tools/checks/verify-deps.mjs` enforces that. Auth state stays outside.
 *
 * Every caller shares one failure policy.
 *
 * - A read that can't produce current state returns `undefined`. That covers missing or
 *   throwing storage, no value, bad JSON, a non-envelope, and a schema version with no
 *   `migrate` or with a `migrate` that throws.
 * - A write that can't store returns `false`. That covers missing or throwing storage, a
 *   full quota and state that isn't JSON-serializable.
 *
 * Nothing throws for storage reasons. Only caller mistakes throw, such as an empty
 * owner, id or prefix, or a schema version that isn't a positive integer.
 */

/**
 * @import { KeyValueStorage, LegacyKeyOptions, PreferenceLoadOptions,
 *   PreferencesConfig } from '@core/preferences/types.js'
 */

// Existing keys in users' browsers use this prefix, so renaming it would lose saved
// preferences.
const DEFAULT_PREFIX = 'ui.component-state';

/** @type {KeyValueStorage | undefined} */
let configuredStorage;
let prefix = DEFAULT_PREFIX;

/**
 * Change the storage backend or key prefix. Call it with no argument to restore the
 * defaults.
 *
 * @param {PreferencesConfig} [config]
 */
export function configurePreferences(config = {}) {
  configuredStorage = config.storage;
  prefix = normalizePart(config.prefix ?? DEFAULT_PREFIX, 'prefix');
}

/**
 * Load one owner's stored preference. Bad JSON, bad envelopes and unavailable storage
 * count as missing, so rendering never fails.
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
 * Persist one owner's preference. Returns false when storage is blocked, full or
 * absent, or when the state isn't JSON-serializable.
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
 * Load one preference, adopting a value an older build wrote under a raw key.
 *
 * Theme and locale once used bare `localStorage` keys. The old value is read once,
 * checked by `accept` and saved as an envelope, and the old key is removed whether or
 * not the value was accepted. Only the caller knows what a valid value is, such as a
 * theme that is still registered.
 *
 * @template T
 * @param {string} owner
 * @param {string} id
 * @param {string} legacyKey Raw storage key an earlier build wrote.
 * @param {LegacyKeyOptions<T>} options
 * @returns {T | undefined}
 * @internal
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
 * A storage adapter that keeps values for the life of the page.
 *
 * Tests use it so cases don't share preferences or leave any in the browser. An
 * application embedded where storage is blocked can use it too.
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

/**
 * @param {string} owner
 * @param {string} id
 * @internal
 */
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
