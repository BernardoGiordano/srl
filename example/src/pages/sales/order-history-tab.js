import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { effect, signal } from '@core/foundation/reactive.js';
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
 * The audit trail of one order, newest first.
 *
 * It also reads `LiveFeed.lastOrderChange`, so a status change made in another tab — or
 * by another user — appears here without a refresh. That is the whole of the wiring: the
 * getter reads a signal, so this element re-renders when the signal changes and nothing
 * subscribes to anything.
 */
export class OrderHistoryTab extends SignalElement {
  rows = signal(/** @type {readonly OrderEvent[]} */ ([]));
  loading = signal(false);
  failed = signal(false);

  /** @type {AbortController | undefined} */
  #request;

  /** @type {(() => void) | undefined} */
  #stopWatching;

  get entries() {
    return this.rows.value;
  }

  onMount() {
    void this.load();

    /*
     * A status change that arrives on the event stream reloads this list. In an effect
     * rather than in a getter, because a getter runs inside the render pass and a fetch
     * started there is a side effect in rendering — the shape that turns one late
     * response into a render loop.
     *
     * The stamp is what makes it idempotent: an effect re-runs whenever anything it
     * read changed, and reloading on a change already folded in would be a request per
     * render.
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
    this.#request?.abort();
    this.#request = undefined;
  }

  async load() {
    const id = routeParams.value.id ?? '';
    if (id === '') return;

    this.#request?.abort();
    const request = new AbortController();
    this.#request = request;
    this.loading.value = true;
    this.failed.value = false;

    try {
      const result = await inject(SALES_SERVICE).orderHistory(id, request.signal);
      if (request.signal.aborted) return;
      this.rows.value = result.rows;
    } catch {
      if (!request.signal.aborted) this.failed.value = true;
    } finally {
      if (this.#request === request) {
        this.loading.value = false;
        this.#request = undefined;
      }
    }
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
