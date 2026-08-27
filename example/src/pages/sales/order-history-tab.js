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
 * The audit trail of one order, newest first.
 *
 * It also reads `LiveFeed.lastOrderChange`, so a status change made in another tab — or
 * by another user — appears here without a refresh. That is the whole of the wiring: the
 * getter reads a signal, so this element re-renders when the signal changes and nothing
 * subscribes to anything.
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
  }

  /**
   * Mounted before the route parameter exists — a tab rendered by a layout whose own
   * match has not landed — there is nothing to ask for. Not asking leaves `pending`
   * true, which is what the screen should be showing.
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
