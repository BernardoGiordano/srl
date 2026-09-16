import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { signal } from '@core/foundation/reactive.js';
import { availableThemes, resolvedTheme, setTheme, theme } from '@core/appearance/theme.js';
import { availableLocales, direction, locale, setLocale, t } from '@core/localization/i18n.js';
import { removePreference } from '@core/preferences/persistence.js';

import { AppBadge } from '../../ui/app-badge.js';
import { AppNotice } from '../../ui/app-notice.js';

/**
 * Let users choose a theme or language and clear saved UI state. The picker reads
 * theme signals, so a system theme change updates the screen. Stored state uses
 * the preference service and the application ids listed below.
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
   * Clear table and filter state while keeping the chosen theme and language.
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

/** Clear sidebar state for the next load. */
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
