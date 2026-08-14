import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { signal } from '@core/foundation/reactive.js';
import { inject } from '@core/foundation/inject.js';
import { routeParams } from '@core/navigation/router.js';
import { cur, dt, num, t } from '@core/localization/i18n.js';

import { AppField } from '../../ui/app-field.js';
import { AppNotice } from '../../ui/app-notice.js';
import { SALES_SERVICE } from '../../services/sales-service.js';

/** @import { Customer } from '../../services/sales-service.js' */

/**
 * The index tab: who the order is for.
 *
 * It fetches the order itself rather than receiving it from the layout above, because a
 * child route is mounted by the router and there is no props channel between the two.
 * That is the honest cost of route-owned children, and it is small: the layout's own
 * request is what pays for the header, this one pays for the customer block, and neither
 * is repeated when the user moves between tabs.
 */
export class OrderSummaryTab extends SignalElement {
  customer = signal(/** @type {Customer | null} */ (null));
  failed = signal(false);

  /** @type {AbortController | undefined} */
  #request;

  get pending() {
    return this.customer.value === null && !this.failed.value;
  }

  get name() {
    return this.customer.value?.name ?? '';
  }

  get segmentLabel() {
    const segment = this.customer.value?.segment;
    return segment === undefined ? '' : t(`customers.segmentValue.${segment}`);
  }

  get since() {
    const since = this.customer.value?.since;
    return since === undefined ? '' : dt(since, { dateStyle: 'medium' });
  }

  get revenue() {
    const customer = this.customer.value;
    return customer === null ? '' : cur(customer.revenue, 'EUR');
  }

  get openOrders() {
    const customer = this.customer.value;
    return customer === null ? '' : num(customer.openOrders);
  }

  get location() {
    const customer = this.customer.value;
    return customer === null ? '' : `${customer.city}, ${customer.country}`;
  }

  get owner() {
    return this.customer.value?.owner ?? '';
  }

  onMount() {
    void this.load();
  }

  onDestroy() {
    this.#request?.abort();
    this.#request = undefined;
  }

  async load() {
    const id = routeParams.value.id ?? '';
    if (id === '') return;

    this.#request?.abort();
    const request = new AbortController();
    this.#request = request;
    this.failed.value = false;

    try {
      const order = await inject(SALES_SERVICE).order(id, request.signal);
      if (request.signal.aborted) return;
      this.customer.value = order.customerDetail;
      this.failed.value = order.customerDetail === null;
    } catch {
      if (!request.signal.aborted) this.failed.value = true;
    } finally {
      if (this.#request === request) this.#request = undefined;
    }
  }
}

await defineComponent({
  tag: 'order-summary-tab',
  element: OrderSummaryTab,
  module: import.meta.url,
  uses: [AppField, AppNotice],
});
