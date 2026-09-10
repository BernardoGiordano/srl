import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { computed, signal } from '@core/foundation/reactive.js';
import { inject } from '@core/foundation/inject.js';
import { routeParams } from '@core/navigation/router.js';
import { cur, dt, num, t } from '@core/localization/i18n.js';

import { AppField } from '../../ui/app-field.js';
import { AppNotice } from '../../ui/app-notice.js';
import { ORDER_RECORDS } from '../../state/order-records.js';

/** @import { Customer } from '../../services/sales-service.js' */
/** @import { OrderRecord } from '../../state/order-records.js' */

/**
 * The index tab: who the order is for.
 *
 * It watches the same settled order record as the layout above. The router hands a child
 * no props, so the application-owned record module is the seam: both route levels ask by
 * id, while one retained resource owns the request, refresh, and final release.
 */
export class OrderSummaryTab extends SignalElement {
  /** The shared record view installed after this element is mounted. */
  #order = signal(/** @type {OrderRecord | null} */ (null));

  pending = computed(() => this.#order.value?.pending.value ?? true);

  /** A missing order and an order with no customer use the same empty panel. */
  failed = computed(() => {
    const order = this.#order.value;
    if (order === null) return false;
    if (order.failed.value) return true;
    return !order.pending.value && order.value.value?.customerDetail === null;
  });

  /** @returns {Customer | null} */
  get customer() {
    return this.#order.value?.value.value?.customerDetail ?? null;
  }

  get name() {
    return this.customer?.name ?? '';
  }

  get segmentLabel() {
    const segment = this.customer?.segment;
    return segment === undefined ? '' : t(`customers.segmentValue.${segment}`);
  }

  get since() {
    const since = this.customer?.since;
    return since === undefined ? '' : dt(since, { dateStyle: 'medium' });
  }

  get revenue() {
    const customer = this.customer;
    return customer === null ? '' : cur(customer.revenue, 'EUR');
  }

  get openOrders() {
    const customer = this.customer;
    return customer === null ? '' : num(customer.openOrders);
  }

  get location() {
    const customer = this.customer;
    return customer === null ? '' : `${customer.city}, ${customer.country}`;
  }

  get owner() {
    return this.customer?.owner ?? '';
  }

  onMount() {
    this.#order.value = inject(ORDER_RECORDS).watch(
      () => routeParams.value.id ?? '',
      this.lifetime,
    );
  }
}

await defineComponent({
  tag: 'order-summary-tab',
  element: OrderSummaryTab,
  module: import.meta.url,
  uses: [AppField, AppNotice],
});
