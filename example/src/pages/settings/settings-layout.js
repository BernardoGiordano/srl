import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { computed } from '@core/foundation/reactive.js';
import { inject } from '@core/foundation/inject.js';
import { RouteOutlet } from '@core/navigation/router.js';
import { t } from '@core/localization/i18n.js';
import { AUTH_SESSION } from '@auth/session.js';

import { AppTabs } from '../../ui/app-tabs.js';

/** @import { TabItem } from '../../ui/app-tabs.js' */

/**
 * Keep Settings tabs mounted around each child screen. Tabs follow session scopes;
 * route guards also check direct navigation.
 */
export class SettingsLayout extends SignalElement {
  /** @type {import('@core/foundation/types.js').ReadonlySignal<readonly TabItem[]>} */
  #tabs = computed(() => {
    const scopes = inject(AUTH_SESSION).scopes.value;
    /** @type {Array<TabItem & { scope?: string }>} */
    const all = [
      { key: 'profile', label: t('nav.settingsProfile'), href: '/settings/profile' },
      { key: 'appearance', label: t('nav.settingsAppearance'), href: '/settings/appearance' },
      { key: 'users', label: t('nav.settingsUsers'), href: '/settings/users', scope: 'users:read' },
      { key: 'audit', label: t('nav.settingsAudit'), href: '/settings/audit', scope: 'audit:read' },
    ];
    return all.filter((tab) => tab.scope === undefined || scopes.includes(tab.scope));
  });

  get tabs() {
    return this.#tabs.value;
  }
}

await defineComponent({
  tag: 'settings-layout',
  element: SettingsLayout,
  module: import.meta.url,
  uses: [AppTabs, RouteOutlet],
});
