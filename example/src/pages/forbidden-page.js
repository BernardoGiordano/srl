import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { inject } from '@core/foundation/inject.js';
import { t } from '@core/localization/i18n.js';
import { AUTH_SESSION } from '@auth/session.js';

/**
 * Where every permission denial lands: `requireScope` in `@auth/guard.js`, and the
 * mount guards built from each remote's `requires` block.
 *
 * Two decisions in nine lines of behaviour.
 *
 * It is guarded by the session and nothing else. Collapsing "not signed in" and "not
 * allowed" into one destination is what sends an authenticated user round a login loop:
 * they sign in, they still lack the scope, they are sent to sign in again.
 *
 * It does not say which entitlement was missing. Naming it turns the page into a list
 * of things to ask an administrator for, which is a decision an application should make
 * deliberately rather than by default. What it does say is who the session belongs to,
 * because the most common cause is being signed in as the wrong person.
 */
export class ForbiddenPage extends SignalElement {
  get userName() {
    return inject(AUTH_SESSION).session.value?.name ?? '';
  }

  get signedInAs() {
    return t('forbidden.signedInAs', { name: this.userName });
  }
}

await defineComponent({ tag: 'forbidden-page', element: ForbiddenPage, module: import.meta.url });
