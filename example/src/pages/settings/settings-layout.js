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
 * Settings: a layout route nested inside the shell's layout route.
 *
 * Three levels of layout are live on this URL — `shell-layout` holds the chrome, this
 * holds the section's tabs, and the child holds the screen — and the router keeps all
 * three mounted, tearing them down deepest first on the way out. That is the case a
 * flat route table cannot express without every screen re-rendering the section's
 * navigation.
 *
 * The tab strip is filtered by scope for the same reason the sidebar is: two of these
 * screens need entitlements, and offering a tab that lands on `/forbidden` is worse than
 * not offering it. The routes are guarded regardless — `routes.js` puts `requireScope`
 * on both — so a typed URL is refused whatever this list says.
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
