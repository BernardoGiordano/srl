import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { inject } from '@core/foundation/inject.js';
import { dt, t } from '@core/localization/i18n.js';
import { AUTH_SESSION } from '@auth/session.js';

import { AppBadge } from '../../ui/app-badge.js';
import { AppField } from '../../ui/app-field.js';

/**
 * Show the current identity and scopes from `AuthSession`. In the BFF example,
 * `expiresAt` marks the backend's renewal time behind the session cookie.
 */
export class SettingsProfile extends SignalElement {
  get session() {
    return inject(AUTH_SESSION).session.value;
  }

  get strategy() {
    return inject(AUTH_SESSION).strategy;
  }

  get scopes() {
    return [...inject(AUTH_SESSION).scopes.value].sort((left, right) => left.localeCompare(right));
  }

  get renewsAt() {
    const session = this.session;
    return session === null ? '' : dt(session.expiresAt, { timeStyle: 'medium', dateStyle: 'short' });
  }

  get strategyNote() {
    return t(`settings.strategyNote.${this.strategy}`);
  }

  /** @param {string} scope */
  scopeTone(scope) {
    return scope.endsWith(':write') ? 'warn' : 'info';
  }
}

await defineComponent({
  tag: 'settings-profile',
  element: SettingsProfile,
  module: import.meta.url,
  uses: [AppBadge, AppField],
});
