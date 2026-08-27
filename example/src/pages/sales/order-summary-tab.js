import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { resource } from '@core/foundation/resource.js';
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
  /**
   * An order with no customer record is a rejection, not a value. The screen has one
   * failure notice — "no customer on this order" — and reaching it through `failed`
   * rather than through a second signal is what keeps the template's two branches two.
   */
  #customer = resource(
    async (signal) => {
      const order = await inject(SALES_SERVICE).order(routeParams.value.id ?? '', signal);
      if (order.customerDetail === null) throw new Error('The order carries no customer record.');
      return order.customerDetail;
    },
    { initial: /** @type {Customer | null} */ (null), lifetime: () => this.lifetime },
  );

  pending = this.#customer.pending;
  failed = this.#customer.failed;

  get name() {
    return this.#customer.value.value?.name ?? '';
  }

  get segmentLabel() {
    const segment = this.#customer.value.value?.segment;
    return segment === undefined ? '' : t(`customers.segmentValue.${segment}`);
  }

  get since() {
    const since = this.#customer.value.value?.since;
    return since === undefined ? '' : dt(since, { dateStyle: 'medium' });
  }

  get revenue() {
    const customer = this.#customer.value.value;
    return customer === null ? '' : cur(customer.revenue, 'EUR');
  }

  get openOrders() {
    const customer = this.#customer.value.value;
    return customer === null ? '' : num(customer.openOrders);
  }

  get location() {
    const customer = this.#customer.value.value;
    return customer === null ? '' : `${customer.city}, ${customer.country}`;
  }

  get owner() {
    return this.#customer.value.value?.owner ?? '';
  }

  onMount() {
    void this.load();
  }

  /**
   * Mounted before the route parameter exists — a tab rendered by a layout whose own
   * match has not landed — there is nothing to ask for. Not asking leaves `pending`
   * true, which is what the screen should be showing.
   */
  load() {
    return (routeParams.value.id ?? '') === '' ? undefined : this.#customer.reload();
  }
}

await defineComponent({
  tag: 'order-summary-tab',
  element: OrderSummaryTab,
  module: import.meta.url,
  uses: [AppField, AppNotice],
});
