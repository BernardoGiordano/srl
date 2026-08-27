import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { computed, effect, signal } from '@core/foundation/reactive.js';
import { resource } from '@core/foundation/resource.js';
import { inject } from '@core/foundation/inject.js';
import { RouteOutlet, routeParams } from '@core/navigation/router.js';
import { cur, dt, t } from '@core/localization/i18n.js';
import { AUTH_SESSION } from '@auth/session.js';

import { AppCard } from '../../ui/app-card.js';
import { AppBadge } from '../../ui/app-badge.js';
import { AppField } from '../../ui/app-field.js';
import { AppNotice } from '../../ui/app-notice.js';
import { AppTabs } from '../../ui/app-tabs.js';
import { SALES_SERVICE } from '../../services/sales-service.js';
import { ApiError } from '@core/http/client.js';

/** @import { Customer, Order } from '../../services/sales-service.js' */
/** @import { TabItem } from '../../ui/app-tabs.js' */

/**
 * One order: a layout route with three child routes.
 *
 * WHAT THE LAYOUT BUYS
 *
 * This component stays mounted while `''`, `lines` and `history` replace each other, so
 * the header is fetched once and switching tabs costs one request for the tab's own
 * data and nothing else. Leaving the section tears the chain down deepest first.
 *
 * WHY THE ID COMES FROM A SIGNAL
 *
 * `routeParams` is a signal, and navigating from `/sales/orders/OR-1` to
 * `/sales/orders/OR-2` does not change the route — only the parameter — so this element
 * is *reused* rather than remounted. Reading the id in `onMount` would therefore leave
 * the second order showing the first one's data. The reload is driven by an effect over
 * the parameter instead, which is the shape that survives both cases.
 *
 * THE WRITE PATH
 *
 * Advancing the status needs `sales:write`. The control is rendered for everybody and
 * disabled with a reason for those who lack it, because a missing button is
 * indistinguishable from a broken one. The server checks the scope regardless — see
 * `example/server/api.mjs` — and a 403 is shown rather than swallowed.
 */
export class OrderDetailPage extends SignalElement {
  #order = resource(
    (signal) => inject(SALES_SERVICE).order(routeParams.value.id ?? '', signal),
    {
      initial: /** @type {(Order & { customerDetail: Customer | null }) | null} */ (null),
      lifetime: () => this.lifetime,
    },
  );

  pending = this.#order.pending;
  failed = this.#order.failed;
  saving = signal(false);
  /** Message key of a failed write, or the empty string. */
  writeErrorKey = signal('');

  /** @type {(() => void) | undefined} */
  #stopWatching;

  get orderId() {
    return routeParams.value.id ?? '';
  }

  /**
   * The record, or nothing while the last load is failing. A resource keeps the value
   * it had, which is right for a list being refreshed and wrong for a header: the
   * previous order's code under a "not found" notice is a worse answer than none.
   */
  get record() {
    return this.failed.value ? null : this.#order.value.value;
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

  /** Why the control is disabled, as a title. Empty when it is not. */
  get advanceHint() {
    if (this.canWrite) return '';
    return t('orders.needsWriteScope');
  }

  get writeError() {
    return this.writeErrorKey.value === '' ? '' : t(this.writeErrorKey.value);
  }

  /**
   * The tab strip. Computed, because the hrefs contain the current id and the labels
   * come from the message table.
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
    // An effect rather than a one-shot load: this element is reused when only the
    // parameter changes, so the parameter is the input to watch.
    let previous = '';
    this.#stopWatching = effect(() => {
      const id = this.orderId;
      if (id === '' || id === previous) return;
      previous = id;
      void this.load();
    });
  }

  onDestroy() {
    this.#stopWatching?.();
    this.#stopWatching = undefined;
  }

  retry() {
    return this.load();
  }

  load() {
    if (this.orderId === '') return undefined;
    this.writeErrorKey.value = '';
    return this.#order.reload();
  }

  advance() {
    const next = this.nextStatus;
    if (next === '' || this.saving.value) return;

    this.saving.value = true;
    this.writeErrorKey.value = '';

    void inject(SALES_SERVICE)
      .setOrderStatus(this.orderId, next)
      // The server is the authority on what the order now is, and the order belongs to
      // the resource: re-reading it is one request, and cheaper than this screen owning
      // a second copy of the record to patch.
      .then(() => this.load())
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
