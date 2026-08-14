import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { inject } from '@core/foundation/inject.js';
import { dt, t } from '@core/localization/i18n.js';
import { AUTH_SESSION } from '@auth/session.js';

import { AppBadge } from '../../ui/app-badge.js';
import { AppField } from '../../ui/app-field.js';

/**
 * The session, shown to its owner.
 *
 * This screen exists to make the auth model visible. Everything on it comes from
 * `AuthSession`, and what is *not* on it is the point: there is no token to show, because
 * with the `bff` strategy the browser never has one. `session.expiresAt` is not a token
 * lifetime either — it is when the backend expects to renew behind the cookie, which is
 * why the label says "renews" rather than "expires".
 *
 * The scope list is the session's own. A remote's `host.auth.permissions()` returns its
 * granted set intersected with this one, so the analytics micro-frontend can see two of
 * these entries and knows nothing about the rest.
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
