import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { signal } from '@core/foundation/reactive.js';
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
  rows = signal(/** @type {readonly OrderLine[]} */ ([]));
  loading = signal(false);
  failed = signal(false);

  /** @type {AbortController | undefined} */
  #request;

  get totalLabel() {
    const total = this.rows.value.reduce((sum, line) => sum + line.total, 0);
    return t('orders.linesTotal', { total: cur(total, 'EUR'), count: this.rows.value.length });
  }

  onMount() {
    void this.load();
  }

  onDestroy() {
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
      const result = await inject(SALES_SERVICE).orderLines(id, request.signal);
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
