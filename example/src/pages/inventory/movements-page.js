import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { resource } from '@core/foundation/resource.js';
import { inject } from '@core/foundation/inject.js';
import { dt, num, t } from '@core/localization/i18n.js';
import { UiTable } from '@components/data/ui-table.js';
import { UiTableColumn } from '@components/data/ui-table-column.js';

import { AppCard } from '../../ui/app-card.js';
import { AppBadge } from '../../ui/app-badge.js';
import { AppNotice } from '../../ui/app-notice.js';
import { ago } from '../../format.js';
import { INVENTORY_SERVICE } from '../../services/inventory-service.js';
import { LIVE_FEED } from '../../services/live-feed.js';

/** @import { Movement } from '../../services/inventory-service.js' */
/** @import { StockEvent } from '../../services/live-feed.js' */

/**
 * Stock movements: a table that grows while you watch it.
 *
 * The initial page is a request; everything after it arrives on the event stream. The
 * merge is four lines in a getter, and the reason it is a getter is that reading the
 * feed's signal is what subscribes this element to it — no listener, no teardown, and no
 * chance of a subscription outliving the screen.
 *
 * The stream's frames and the API's rows are the same shape because they come from the
 * same objects on the server, so there is nothing to normalise. That is worth arranging
 * deliberately: a live feed whose payload differs from the resource it updates makes
 * every consumer write the adapter.
 */
export class MovementsPage extends SignalElement {
  #fetched = resource(
    (signal) => inject(INVENTORY_SERVICE).movements(120, signal).then((result) => result.rows),
    { initial: /** @type {Movement[]} */ ([]), lifetime: () => this.lifetime },
  );

  loading = this.#fetched.pending;
  failed = this.#fetched.failed;

  /**
   * The fetched page with the streamed movements in front of it, de-duplicated by id: a
   * reload after some events have arrived would otherwise show both copies.
   */
  get rows() {
    /** @type {Array<Movement | StockEvent>} */
    const merged = [...inject(LIVE_FEED).movements.value, ...this.#fetched.value.value];
    /** @type {Set<string>} */
    const seen = new Set();
    return merged.filter((movement) => {
      if (seen.has(movement.id)) return false;
      seen.add(movement.id);
      return true;
    });
  }

  get connected() {
    return inject(LIVE_FEED).connected.value;
  }

  get streamLabel() {
    return this.connected ? t('live.connected', { count: inject(LIVE_FEED).received.value }) : t('live.reconnecting');
  }

  onMount() {
    void this.load();
  }

  load() {
    return this.#fetched.reload();
  }

  /** @param {unknown} row */
  renderKind = (row) => {
    const movement = /** @type {Movement} */ (row);
    const badge = document.createElement('app-badge');
    badge.setAttribute('tone', movement.kind === 'issue' ? 'warn' : 'good');
    badge.textContent = t(`movements.kind.${movement.kind}`);
    return badge;
  };

  /** @param {unknown} row */
  filterKind = (row) => t(`movements.kind.${/** @type {Movement} */ (row).kind}`);

  /** @param {unknown} row */
  renderQuantity = (row) => {
    const movement = /** @type {Movement} */ (row);
    return num(movement.kind === 'issue' ? -movement.quantity : movement.quantity, { signDisplay: 'always' });
  };

  /** @param {unknown} row */
  renderAt = (row) => dt(/** @type {Movement} */ (row).at, { dateStyle: 'short', timeStyle: 'medium' });

  /** @param {unknown} row */
  renderAgo = (row) => ago(/** @type {Movement} */ (row).at);

  /** @param {unknown} row */
  rowKey = (row) => /** @type {Movement} */ (row).id;
}

await defineComponent({
  tag: 'movements-page',
  element: MovementsPage,
  module: import.meta.url,
  uses: [AppCard, AppBadge, AppNotice, UiTable, UiTableColumn],
});
