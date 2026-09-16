import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { computed, signal } from '@core/foundation/reactive.js';
import { inject } from '@core/foundation/inject.js';
import { RouteOutlet, routeParams } from '@core/navigation/router.js';
import { cur, dt, t } from '@core/localization/i18n.js';
import { AUTH_SESSION } from '@auth/session.js';

import { AppCard } from '../../ui/app-card.js';
import { AppBadge } from '../../ui/app-badge.js';
import { AppField } from '../../ui/app-field.js';
import { AppNotice } from '../../ui/app-notice.js';
import { AppTabs } from '../../ui/app-tabs.js';
import { ORDER_RECORDS } from '../../state/order-records.js';
import { ApiError } from '@core/http/client.js';

/** @import { OrderRecord } from '../../state/order-records.js' */
/** @import { TabItem } from '../../ui/app-tabs.js' */

/**
 * Keep the order header mounted while its three tabs change. `OrderRecords.watch()`
 * follows the route id when this element is reused for another order. Status changes
 * require `sales:write`; the control explains when that scope is missing.
 */
export class OrderDetailPage extends SignalElement {
  /** The shared record view installed after this element is mounted. */
  #order = signal(/** @type {OrderRecord | null} */ (null));

  pending = computed(() => this.#order.value?.pending.value ?? true);
  failed = computed(() => this.#order.value?.failed.value ?? false);
  saving = signal(false);
  /** Message key of a failed write, or the empty string. */
  writeErrorKey = signal('');

  get orderId() {
    return routeParams.value.id ?? '';
  }

  /**
   * Hide the previous order's header when a new request fails.
   */
  get record() {
    return this.failed.value ? null : (this.#order.value?.value.value ?? null);
  }

  get code() {
    return this.record?.code ?? this.orderId;
  }

  get status() {
    return this.record?.status ?? '';
  }

  get statusLabel() {
    return this.status === '' ? '' : t(`orders.statusValue.${this.status}`);
  }

  get statusTone() {
    switch (this.status) {
      case 'shipped':
      case 'invoiced':
        return 'good';
      case 'cancelled':
        return 'bad';
      case 'confirmed':
        return 'info';
      default:
        return 'neutral';
    }
  }

  get customerName() {
    return this.record?.customer ?? '';
  }

  get customerLink() {
    return '/sales/customers';
  }

  get total() {
    const order = this.record;
    return order === null ? '' : cur(order.total, order.currency);
  }

  get placedOn() {
    const order = this.record;
    return order === null ? '' : dt(order.placedOn, { dateStyle: 'long' });
  }

  get promisedOn() {
    const order = this.record;
    return order === null ? '' : dt(order.promisedOn, { dateStyle: 'long' });
  }

  get comune() {
    return this.record?.comune ?? '';
  }

  get owner() {
    return this.record?.owner ?? '';
  }

  /** The next status in the workflow, or the empty string at the end of it. */
  get nextStatus() {
    const flow = ['draft', 'confirmed', 'shipped', 'invoiced'];
    const index = flow.indexOf(this.status);
    return index === -1 || index === flow.length - 1 ? '' : (flow[index + 1] ?? '');
  }

  get advanceLabel() {
    return this.nextStatus === ''
      ? t('orders.noNextStatus')
      : t('orders.advanceTo', { status: t(`orders.statusValue.${this.nextStatus}`) });
  }

  get canWrite() {
    return inject(AUTH_SESSION).scopes.value.includes('sales:write');
  }

  get advanceDisabled() {
    return !this.canWrite || this.nextStatus === '' || this.saving.value;
  }

/** Explain why the status control is disabled. */
  get advanceHint() {
    if (this.canWrite) return '';
    return t('orders.needsWriteScope');
  }

  get writeError() {
    return this.writeErrorKey.value === '' ? '' : t(this.writeErrorKey.value);
  }

  /**
   * Build tab links and labels from the current id and language.
   *
   * @type {import('@core/foundation/types.js').ReadonlySignal<readonly TabItem[]>}
   */
  #tabs = computed(() => {
    const base = `/sales/orders/${this.orderId}`;
    return [
      // `exact`, because this href is a prefix of both siblings.
      { key: 'summary', label: t('orders.tabSummary'), href: base, exact: true },
      { key: 'lines', label: t('orders.tabLines'), href: `${base}/lines` },
      { key: 'history', label: t('orders.tabHistory'), href: `${base}/history` },
    ];
  });

  get tabs() {
    return this.#tabs.value;
  }

  onMount() {
    // The child tab shares this keyed record until both readers release it.
    this.#order.value = inject(ORDER_RECORDS).watch(() => this.orderId, this.lifetime);
  }

  retry() {
    return this.load();
  }

  load() {
    this.writeErrorKey.value = '';
    return this.#order.value?.reload();
  }

  advance() {
    const next = this.nextStatus;
    const order = this.#order.value;
    if (next === '' || this.saving.value || order === null) return;

    this.saving.value = true;
    this.writeErrorKey.value = '';

    // The shared record refreshes after a status write.
    void order
      .setStatus(next)
      .catch((cause) => {
        this.writeErrorKey.value =
          cause instanceof ApiError && cause.forbidden ? 'orders.writeForbidden' : 'common.saveFailed';
      })
      .finally(() => {
        this.saving.value = false;
      });
  }
}

await defineComponent({
  tag: 'order-detail-page',
  element: OrderDetailPage,
  module: import.meta.url,
  uses: [AppCard, AppBadge, AppField, AppNotice, AppTabs, RouteOutlet],
});
