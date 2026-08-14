import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { currentPath } from '@core/navigation/router.js';
import { t } from '@core/localization/i18n.js';

/**
 * The catch-all. Eager rather than lazy: a route table that needs a network request
 * before it can say a URL is wrong is worse than one that costs two kilobytes.
 *
 * It reads `currentPath` rather than `location.pathname` so the message follows a
 * navigation that also fails — clicking a second dead link updates the text instead of
 * leaving the first URL on screen.
 */
export class NotFoundPage extends SignalElement {
  get body() {
    return t('page.notFoundBody', { path: currentPath.value });
  }
}

await defineComponent({ tag: 'not-found-page', element: NotFoundPage, module: import.meta.url });
