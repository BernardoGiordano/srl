import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { effect } from '@core/foundation/reactive.js';
import { resource } from '@core/foundation/resource.js';
import { inject } from '@core/foundation/inject.js';
import { routeParams } from '@core/navigation/router.js';
import { dt, t } from '@core/localization/i18n.js';

import { AppBadge } from '../../ui/app-badge.js';
import { ago } from '../../format.js';
import { AppNotice } from '../../ui/app-notice.js';
import { SALES_SERVICE } from '../../services/sales-service.js';
import { LIVE_FEED } from '../../services/live-feed.js';

/** @import { OrderEvent } from '../../services/sales-service.js' */

/**
 * Show an order's audit trail, newest first. A live status event reloads the list.
 */
export class OrderHistoryTab extends SignalElement {
  #history = resource(
    (signal) =>
      inject(SALES_SERVICE)
        .orderHistory(routeParams.value.id ?? '', signal)
        .then((result) => result.rows),
    { initial: /** @type {OrderEvent[]} */ ([]), lifetime: () => this.lifetime },
  );

  loading = this.#history.pending;
  failed = this.#history.failed;

  /** @type {(() => void) | undefined} */
  #stopWatching;

  get entries() {
    return this.#history.value.value;
  }

  onMount() {
    void this.load();

    /*
     * Reload after a new status event. The stamp prevents repeated requests when
     * the effect runs again.
     */
    let seen = '';
    this.#stopWatching = effect(() => {
      const change = inject(LIVE_FEED).lastOrderChange.value;
      if (change === null || change.id !== (routeParams.value.id ?? '')) return;
      const stamp = `${change.id}:${change.status}`;
      if (stamp === seen) return;
      seen = stamp;
      void this.load();
    });
  }

  onDestroy() {
    this.#stopWatching?.();
    this.#stopWatching = undefined;
  }

  /**
   * Wait for the route's order id before fetching history.
   */
  load() {
    return (routeParams.value.id ?? '') === '' ? undefined : this.#history.reload();
  }

  /** @param {OrderEvent} entry */
  eventLabel(entry) {
    return t(`orders.event.${entry.event}`);
  }

  /** @param {OrderEvent} entry */
  when(entry) {
    return dt(entry.at, { dateStyle: 'medium', timeStyle: 'short' });
  }

  /** @param {OrderEvent} entry */
  since(entry) {
    return ago(entry.at);
  }

  /** @param {OrderEvent} entry */
  tone(entry) {
    return entry.event === 'status' ? 'info' : 'neutral';
  }
}

await defineComponent({
  tag: 'order-history-tab',
  element: OrderHistoryTab,
  module: import.meta.url,
  uses: [AppBadge, AppNotice],
});
