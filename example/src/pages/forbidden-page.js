import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { inject } from '@core/foundation/inject.js';
import { t } from '@core/localization/i18n.js';
import { AUTH_SESSION } from '@auth/session.js';

/**
 * Show permission denials from route and remote guards. The page keeps signed-in
 * users out of the login loop and shows which account they are using.
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
