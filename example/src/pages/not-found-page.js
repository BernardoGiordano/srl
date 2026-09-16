import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { currentPath } from '@core/navigation/router.js';
import { t } from '@core/localization/i18n.js';

/**
 * Show the current unmatched path. The route loads eagerly and reads `currentPath`
 * so another failed navigation updates the message.
 */
export class NotFoundPage extends SignalElement {
  get body() {
    return t('page.notFoundBody', { path: currentPath.value });
  }
}

await defineComponent({ tag: 'not-found-page', element: NotFoundPage, module: import.meta.url });
