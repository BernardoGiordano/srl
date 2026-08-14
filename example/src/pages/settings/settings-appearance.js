import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { signal } from '@core/foundation/reactive.js';
import { availableThemes, resolvedTheme, setTheme, theme } from '@core/appearance/theme.js';
import { availableLocales, direction, locale, setLocale, t } from '@core/localization/i18n.js';
import { removePreference } from '@core/preferences/persistence.js';

import { AppBadge } from '../../ui/app-badge.js';
import { AppNotice } from '../../ui/app-notice.js';

/**
 * Appearance: the theme, the language, and the stored UI state behind both.
 *
 * WHAT THE THEME PICKER IS
 *
 * `theme` is the preference (`system`, `light`, `dark`, `ocean`); `resolvedTheme` is what
 * `system` resolved to. Both are signals, so this screen renders from them and re-renders
 * when the operating system's own setting changes underneath it — which is the case a
 * component holding its own copy of the choice gets wrong.
 *
 * WHAT THE RESET BUTTON IS FOR
 *
 * Every non-auth preference in this application goes through
 * `@core/preferences/persistence.js`: the sidebar's collapsed state, four tables' column
 * layouts, three filters' values, the theme and the locale. Nothing calls `localStorage`
 * directly — `npm run verify` fails the build if anything in the library or the collection
 * does — which is why one screen can offer to clear all of it, and why the list below is
 * the honest inventory rather than a guess.
 *
 * The ids are written down here because they are this application's: an owner plus an id
 * is the whole key shape, and the owners are the components' own names.
 */
export class SettingsAppearance extends SignalElement {
  /** Which reset ran, for the confirmation line. Empty means none yet. */
  clearedKey = signal('');

  get themeName() {
    return theme.value;
  }

  get resolved() {
    return resolvedTheme.value;
  }

  get themes() {
    return availableThemes.value.map((name) => ({ name, label: t(`theme.${name}`) }));
  }

  get localeCode() {
    return locale.value;
  }

  get locales() {
    return availableLocales.value;
  }

  get textDirection() {
    return direction.value;
  }

  get cleared() {
    return this.clearedKey.value === '' ? '' : t(this.clearedKey.value);
  }

  /** @param {string} name */
  chooseTheme(name) {
    setTheme(name);
  }

  /** @param {string} name */
  isCurrentTheme(name) {
    return this.themeName === name;
  }

  /** @param {Event} event */
  selectLocale(event) {
    if (event.target instanceof HTMLSelectElement) void setLocale(event.target.value);
  }

  /**
   * Clear the table and filter state this application stores, leaving the theme and the
   * locale alone: someone resetting a column layout has not asked to be put back into
   * English.
   */
  resetTables() {
    for (const id of ['sales-orders', 'sales-customers', 'inventory-products', 'inventory-movements', 'people-employees']) {
      removePreference('ui-table', id);
    }
    for (const name of ['sales-orders', 'inventory-products', 'people-employees']) {
      removePreference('ui-dynamic-filter', name);
    }
    this.clearedKey.value = 'settings.clearedTables';
  }

  /** Clear the sidebar's collapsed state. Takes effect on the next load, by design:
   * writing it back now would fight the element that owns it. */
  resetSidebar() {
    removePreference('ui-sidebar', 'example.sidebar');
    this.clearedKey.value = 'settings.clearedSidebar';
  }
}

await defineComponent({
  tag: 'settings-appearance',
  element: SettingsAppearance,
  module: import.meta.url,
  uses: [AppBadge, AppNotice],
});
