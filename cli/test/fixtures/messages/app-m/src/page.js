import { t } from '@core/localization/i18n.js';
import { standardText } from '@components/internal/text.js';

export class Page extends HTMLElement {
  // A typo: written down, never declared, and a raw key in the page.
  missing() {
    return t('orders.titel');
  }

  // Plural: only the variants exist, and `count` is what reaches them.
  itemCount(n) {
    return t('cart.items', { count: n });
  }

  // A parameter the message interpolates and this call does not pass.
  greeting(name) {
    return t('orders.greeting', { name });
  }

  // Both branches are written down.
  status(open) {
    return t(open ? 'orders.status.open' : 'orders.status.closed');
  }

  // Computed, and it claims every key under the prefix.
  label(name) {
    return t('orders.status.' + name);
  }

  // A collection key, built by the collection from its own namespace.
  empty() {
    return standardText('table', 'empty');
  }
}

await defineComponent({ tag: 'fx-page', element: Page, module: import.meta.url });
