import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { inject } from '@core/foundation/inject.js';
import { num, t } from '@core/localization/i18n.js';

import { AppBadge } from '../../ui/app-badge.js';
import { ago } from '../../format.js';
import { LIVE_FEED } from '../../services/live-feed.js';

/** @import { StockEvent } from '../../services/live-feed.js' */

/**
 * Show recent stock movements from `LiveFeed` signals. The outlet sets `limit` as
 * a reactive property. Its default stays in the getter so a class field cannot
 * shadow the reactive accessor.
 */
export class LivePanel extends SignalElement {
  static properties = {
    limit: { type: Number },
  };

  /** @type {number | undefined} */
  #limit;

  set limit(value) {
    this.#limit = value;
    this.requestUpdate();
  }

  get limit() {
    return this.#limit ?? 6;
  }

  get connected() {
    return inject(LIVE_FEED).connected.value;
  }

  get movements() {
    return inject(LIVE_FEED).movements.value.slice(0, this.limit);
  }

  get received() {
    return inject(LIVE_FEED).received.value;
  }

  get statusText() {
    return this.connected ? t('live.connected', { count: this.received }) : t('live.reconnecting');
  }

  /** @param {StockEvent} movement */
  quantity(movement) {
    const signed = movement.kind === 'issue' ? -movement.quantity : movement.quantity;
    return num(signed, { signDisplay: 'always' });
  }

  /**
   * Format the movement time for the active locale.
   *
   * @param {StockEvent} movement
   */
  when(movement) {
    return ago(movement.at);
  }

  /** @param {StockEvent} movement */
  tone(movement) {
    if (movement.belowReorder) return 'bad';
    return movement.kind === 'issue' ? 'warn' : 'good';
  }

  /** @param {StockEvent} movement */
  kindLabel(movement) {
    return t(`movements.kind.${movement.kind}`);
  }
}

await defineComponent({
  tag: 'live-panel',
  element: LivePanel,
  module: import.meta.url,
  uses: [AppBadge],
});
