import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { resource } from '@core/foundation/resource.js';
import { inject } from '@core/foundation/inject.js';
import { routeParams } from '@core/navigation/router.js';
import { cur, num, t } from '@core/localization/i18n.js';
import { UiTable } from '@components/data/ui-table.js';
import { UiTableColumn } from '@components/data/ui-table-column.js';

import { AppNotice } from '../../ui/app-notice.js';
import { SALES_SERVICE } from '../../services/sales-service.js';

/** @import { OrderLine } from '../../services/sales-service.js' */

/**
 * Show an order's few lines in a sortable table without a pager.
 */
export class OrderLinesTab extends SignalElement {
  #lines = resource(
    (signal) =>
      inject(SALES_SERVICE)
        .orderLines(routeParams.value.id ?? '', signal)
        .then((result) => result.rows),
    { initial: /** @type {OrderLine[]} */ ([]), lifetime: () => this.lifetime },
  );

  rows = this.#lines.value;
  loading = this.#lines.pending;
  failed = this.#lines.failed;

  get totalLabel() {
    const lines = this.rows.value;
    const total = lines.reduce((sum, line) => sum + line.total, 0);
    return t('orders.linesTotal', { total: cur(total, 'EUR'), count: lines.length });
  }

  onMount() {
    void this.load();
  }

  /**
   * Wait for the route's order id before fetching lines.
   */
  load() {
    return (routeParams.value.id ?? '') === '' ? undefined : this.#lines.reload();
  }

  /** @param {unknown} row */
  renderQuantity = (row) => num(/** @type {OrderLine} */ (row).quantity);

  /** @param {unknown} row */
  renderUnitPrice = (row) => cur(/** @type {OrderLine} */ (row).unitPrice, 'EUR');

  /** @param {unknown} row */
  renderTotal = (row) => cur(/** @type {OrderLine} */ (row).total, 'EUR');

  /** @param {unknown} row */
  rowKey = (row) => String(/** @type {OrderLine} */ (row).line);
}

await defineComponent({
  tag: 'order-lines-tab',
  element: OrderLinesTab,
  module: import.meta.url,
  uses: [AppNotice, UiTable, UiTableColumn],
});
