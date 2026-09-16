import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { resource } from '@core/foundation/resource.js';
import { computed, signal } from '@core/foundation/reactive.js';
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
 * Show fetched movements and new events in one windowed table. Incoming rows land
 * at the top, so selection follows row keys instead of positions.
 */
export class MovementsPage extends SignalElement {
  #fetched = resource(
    (signal) => inject(INVENTORY_SERVICE).movements(120, signal).then((result) => result.rows),
    { initial: /** @type {Movement[]} */ ([]), lifetime: () => this.lifetime },
  );

  loading = this.#fetched.pending;
  failed = this.#fetched.failed;

  /**
   * Merge fetched and streamed rows by id. The computed array keeps its identity
   * until the data changes, which preserves the table's scroll position.
   *
   * @type {import('@core/foundation/types.js').ReadonlySignal<Array<Movement | StockEvent>>}
   */
  #rows = computed(() => {
    const merged = [...inject(LIVE_FEED).movements.value, ...this.#fetched.value.value];
    /** @type {Set<string>} */
    const seen = new Set();
    return merged.filter((movement) => {
      if (seen.has(movement.id)) return false;
      seen.add(movement.id);
      return true;
    });
  });

  get rows() {
    return this.#rows.value;
  }

  /**
   * Selected movement keys, stable as new rows arrive.
   */
  selectedKeys = signal(/** @type {readonly unknown[]} */ ([]));

  get selectionCount() {
    return this.selectedKeys.value.length;
  }

  /**
   * Net selected quantity, with issues counted as negative.
   */
  get selectedNet() {
    const chosen = new Set(this.selectedKeys.value.map(String));
    let net = 0;
    for (const movement of this.rows) {
      if (!chosen.has(movement.id)) continue;
      net += movement.kind === 'issue' ? -movement.quantity : movement.quantity;
    }
    return num(net, { signDisplay: 'always' });
  }

  /** @param {Event} event */
  captureSelection(event) {
    this.selectedKeys.value = /** @type {CustomEvent<{ keys: readonly unknown[] }>} */ (
      event
    ).detail.keys;
  }

  clearSelection() {
    this.selectedKeys.value = [];
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
