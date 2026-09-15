/**
 * Runtime theme selection for the document and its light-DOM components.
 *
 * Components use semantic custom properties such as `--ui-color-surface`, and this
 * module picks which theme supplies them. The `light` and `dark` values come from the
 * linked palette stylesheet (`@components/theme-default.css` by default), so both work
 * before JavaScript runs and follow `prefers-color-scheme` under `system`. A registered
 * theme supplies its tokens through this module instead.
 */

import { computed, signal } from '@core/foundation/reactive.js';
import { migrateLegacyKey, savePreference } from '@core/preferences/persistence.js';

/** @import { ThemeConfig, ThemeDefinition, ThemePreference } from '@core/appearance/types.js' */

/**
 * The preference this module owns. `storageKey` is the preference id, so the stored key
 * is `ui.component-state:theme:<storageKey>`. A value an older build wrote under the
 * bare key is adopted once, so saved themes survive the upgrade.
 */
const STATE_COMPONENT = 'theme';
const THEME_STATE_VERSION = 1;
const DEFAULT_STORAGE_KEY = 'ui.theme';
const BUILTIN_NAMES = /** @type {const} */ (['light', 'dark']);
const media = window.matchMedia('(prefers-color-scheme: dark)');

/** @type {Map<string, ThemeDefinition>} */
const definitions = new Map([
  ['light', { colorScheme: 'light', tokens: {} }],
  ['dark', { colorScheme: 'dark', tokens: {} }],
]);

/** The selected theme name, including the special `system` preference. */
/** @type {import('@core/foundation/types.js').Signal<ThemePreference>} */
export const theme = signal(/** @type {ThemePreference} */ ('system'));

const systemDark = signal(media.matches);

/** The concrete theme whose tokens are applied to the document. */
export const resolvedTheme = computed(() =>
  theme.value === 'system' ? (systemDark.value ? 'dark' : 'light') : theme.value,
);

/** Names an application can show in a theme picker, in registration order. */
/** @type {import('@core/foundation/types.js').Signal<ReadonlyArray<ThemePreference>>} */
export const availableThemes = signal(
  /** @type {ReadonlyArray<ThemePreference>} */ (['system', ...BUILTIN_NAMES]),
);

let target = document.documentElement;
let storageKey = DEFAULT_STORAGE_KEY;
let configured = false;
/** @type {Set<string>} */
const appliedTokens = new Set();

media.addEventListener('change', (event) => {
  systemDark.value = event.matches;
  if (theme.peek() === 'system') applyTheme();
});

/**
 * Register custom themes and restore the starting preference.
 *
 * @param {ThemeConfig} [next]
 */
export function configureTheme(next = {}) {
  const nextTarget = next.target ?? document.documentElement;
  if (configured && target !== nextTarget) {
    for (const token of appliedTokens) target.style.removeProperty(token);
    delete target.dataset.theme;
    delete target.dataset.themePreference;
    target.style.colorScheme = '';
    appliedTokens.clear();
  }
  target = nextTarget;
  storageKey = next.storageKey ?? DEFAULT_STORAGE_KEY;

  for (const name of [...definitions.keys()]) {
    if (!BUILTIN_NAMES.includes(/** @type {'light' | 'dark'} */ (name))) definitions.delete(name);
  }

  for (const [name, definition] of Object.entries(next.themes ?? {})) {
    registerTheme(name, definition, false);
  }
  publishAvailableThemes();

  const fallback = next.defaultTheme ?? 'system';
  assertKnownTheme(fallback);
  const stored = readPreference();
  const starting = stored !== undefined && isKnownTheme(stored) ? stored : fallback;

  configured = true;
  setTheme(starting, { persist: false });
}

/**
 * Add or replace a named custom theme at runtime.
 *
 * @param {string} name
 * @param {ThemeDefinition} definition
 * @param {boolean} [publish]
 */
export function registerTheme(name, definition, publish = true) {
  if (name === 'system' || BUILTIN_NAMES.includes(/** @type {'light' | 'dark'} */ (name))) {
    throw new Error(`[theme] "${name}" is reserved.`);
  }
  if (!/^[a-z][a-z0-9-]*$/u.test(name)) {
    throw new Error(`[theme] "${name}" must be a lowercase CSS identifier.`);
  }
  if (definition.colorScheme !== 'light' && definition.colorScheme !== 'dark') {
    throw new Error(`[theme] "${name}" must declare colorScheme as "light" or "dark".`);
  }

  const tokens = { ...(definition.tokens ?? {}) };
  for (const [token, value] of Object.entries(tokens)) {
    if (!/^--ui-[a-z0-9-]+$/u.test(token)) {
      throw new Error(`[theme] Custom token "${token}" must start with --ui-.`);
    }
    if (value.trim() === '') {
      throw new Error(`[theme] Custom token "${token}" must have a non-empty string value.`);
    }
  }

  definitions.set(name, { colorScheme: definition.colorScheme, tokens });
  if (publish) publishAvailableThemes();
  if (configured && resolvedTheme.peek() === name) applyTheme();
}

/**
 * Select `system`, a built-in theme, or a registered custom theme.
 *
 * @param {ThemePreference} name
 * @param {{ persist?: boolean }} [options]
 */
export function setTheme(name, options = {}) {
  assertKnownTheme(name);
  theme.value = name;
  applyTheme();

  if (options.persist === false) return;
  // A failed save returns `false`, as in private browsing, and the theme still applies.
  savePreference(STATE_COMPONENT, storageKey, name, {
    schemaVersion: THEME_STATE_VERSION,
  });
}

function applyTheme() {
  const resolved = resolvedTheme.peek();
  const definition = definitions.get(resolved);
  if (definition === undefined) return;

  target.dataset.theme = resolved;
  target.dataset.themePreference = theme.peek();
  target.style.colorScheme = definition.colorScheme;

  for (const token of appliedTokens) target.style.removeProperty(token);
  appliedTokens.clear();

  const entries = /** @type {Array<[string, string]>} */ (
    Object.entries(definition.tokens ?? {})
  );
  for (const [token, value] of entries) {
    target.style.setProperty(token, value);
    appliedTokens.add(token);
  }

  target.dispatchEvent(
    new CustomEvent('themechange', {
      detail: { theme: theme.peek(), resolvedTheme: resolved },
      bubbles: true,
      composed: true,
    }),
  );
}

function publishAvailableThemes() {
  availableThemes.value = /** @type {ReadonlyArray<ThemePreference>} */ ([
    'system',
    ...definitions.keys(),
  ]);
}

/** @param {string} name @returns {boolean} */
function isKnownTheme(name) {
  return name === 'system' || definitions.has(name);
}

/** @param {string} name */
function assertKnownTheme(name) {
  if (!isKnownTheme(name)) {
    throw new Error(
      `[theme] Unknown theme "${name}". Available themes: ${availableThemes.peek().join(', ')}.`,
    );
  }
}

/**
 * The stored preference, or undefined when there's nothing to restore. `accept` drops a
 * theme the application no longer registers, and every other failure is already
 * `undefined`.
 *
 * @returns {string | undefined}
 */
function readPreference() {
  return migrateLegacyKey(STATE_COMPONENT, storageKey, storageKey, {
    schemaVersion: THEME_STATE_VERSION,
    accept: (raw) => (isKnownTheme(raw) ? raw : undefined),
  });
}
