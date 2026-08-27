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
 * The lines of one order: `pagination="none"`.
 *
 * Six rows do not need paging, and `none` is the mode for that — the table still sorts
 * and still applies filters, it just does not slice. Reaching for `client` here would
 * add a pager under six rows; reaching for a plain `<table>` would give up sorting and
 * the accessible column semantics `ui-table` already has.
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
   * Mounted before the route parameter exists — a tab rendered by a layout whose own
   * match has not landed — there is nothing to ask for. Not asking leaves `pending`
   * true, which is what the screen should be showing.
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
