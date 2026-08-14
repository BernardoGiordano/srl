import { assert } from '../harness.js';
import {
  configurePreferences,
  createMemoryStorage,
  loadPreference,
  savePreference,
} from '@core/preferences/persistence.js';
import {
  availableThemes,
  configureTheme,
  registerTheme,
  resolvedTheme,
  setTheme,
  theme,
} from '@core/appearance/theme.js';

/**
 * The theme is a UI preference, so what it persists is asserted through the preference
 * module rather than against `localStorage`. That is the point of the seam: this suite
 * runs entirely against a memory store, leaves nothing in the browser, and would fail if
 * the theme ever went back to keeping a slot of its own.
 */

describe('theme', () => {
  const storageKey = 'test.theme';
  /** @type {ReturnType<typeof createMemoryStorage>} */
  let storage;
  /** @type {HTMLElement} */
  let target;

  beforeEach(() => {
    storage = createMemoryStorage();
    configurePreferences({ storage });
    target = document.createElement('div');
    configureTheme({ target, storageKey, defaultTheme: 'light' });
  });

  afterEach(() => {
    configureTheme({ target: document.documentElement, defaultTheme: 'system' });
    configurePreferences();
  });

  it('reflects and persists an explicit light or dark preference', () => {
    setTheme('dark');

    assert.equal(theme.value, 'dark');
    assert.equal(resolvedTheme.value, 'dark');
    assert.equal(target.dataset.theme, 'dark');
    assert.equal(target.dataset.themePreference, 'dark');
    assert.equal(target.style.colorScheme, 'dark');
    assert.equal(loadPreference('theme', storageKey), 'dark');
  });

  it('registers a custom theme and removes its overrides when switching away', () => {
    registerTheme('forest', {
      colorScheme: 'dark',
      tokens: {
        '--ui-color-primary': '#4ade80',
        '--ui-color-canvas': '#07130c',
      },
    });

    assert.ok(availableThemes.value.includes('forest'));
    setTheme('forest');
    assert.equal(target.dataset.theme, 'forest');
    assert.equal(target.style.getPropertyValue('--ui-color-primary'), '#4ade80');

    setTheme('light');
    assert.equal(target.style.getPropertyValue('--ui-color-primary'), '');
    assert.equal(target.style.getPropertyValue('--ui-color-canvas'), '');
  });

  it('restores a valid persisted custom theme during configuration', () => {
    savePreference('theme', storageKey, 'forest');

    configureTheme({
      target,
      storageKey,
      defaultTheme: 'light',
      themes: {
        forest: {
          colorScheme: 'dark',
          tokens: { '--ui-color-primary': '#4ade80' },
        },
      },
    });

    assert.equal(theme.value, 'forest');
    assert.equal(target.dataset.theme, 'forest');
  });

  /**
   * Before UI preferences had one owner the theme wrote its name straight into
   * `localStorage[storageKey]`. Anyone upgrading has that value and no envelope, and
   * resetting everyone's theme to `system` on the first load after a deployment is not
   * an acceptable way to tidy a storage key.
   */
  it('adopts a theme an earlier build stored under the bare key', () => {
    storage.setItem(storageKey, 'dark');

    configureTheme({ target, storageKey, defaultTheme: 'light' });

    assert.equal(theme.value, 'dark');
    assert.equal(target.dataset.theme, 'dark');
    assert.equal(loadPreference('theme', storageKey), 'dark', 'and it is an envelope now');
    assert.equal(storage.getItem(storageKey), null, 'the bare key is read once and dropped');
  });

  it('ignores a legacy value naming a theme this build no longer registers', () => {
    storage.setItem(storageKey, 'forest');

    configureTheme({ target, storageKey, defaultTheme: 'light' });

    assert.equal(theme.value, 'light', 'the configured default, not an unregistered name');
    assert.equal(storage.getItem(storageKey), null);
  });

  it('renders a theme even when storage is blocked entirely', () => {
    configurePreferences({
      storage: {
        getItem: () => {
          throw new DOMException('blocked', 'SecurityError');
        },
        setItem: () => {
          throw new DOMException('blocked', 'SecurityError');
        },
        removeItem: () => {
          throw new DOMException('blocked', 'SecurityError');
        },
      },
    });

    configureTheme({ target, storageKey, defaultTheme: 'light' });
    assert.equal(theme.value, 'light');

    setTheme('dark');
    assert.equal(target.dataset.theme, 'dark', 'a blocked store may not stop a repaint');
  });

  it('rejects unknown themes and custom properties outside the library namespace', () => {
    assert.throws(() => setTheme('missing'), 'Unknown theme');
    const invalid = /** @type {import('@core/appearance/types.js').ThemeDefinition} */ (
      /** @type {unknown} */ ({
        colorScheme: 'light',
        tokens: { '--app-secret': 'red' },
      })
    );
    assert.throws(
      () => registerTheme('unsafe', invalid),
      'must start with --ui-',
    );
  });
});
