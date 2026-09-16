import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { computed, signal } from '@core/foundation/reactive.js';
import { resource } from '@core/foundation/resource.js';
import { inject } from '@core/foundation/inject.js';
import { cur, dt, t } from '@core/localization/i18n.js';
import { ANY_COLUMN, RANGE_SEPARATOR } from '@components/data/filter-descriptor.js';
import { UiTable } from '@components/data/ui-table.js';
import { UiTableColumn } from '@components/data/ui-table-column.js';
import { UiDynamicFilter } from '@components/data/ui-dynamic-filter.js';

import { AppCard } from '../../ui/app-card.js';
import { AppNotice } from '../../ui/app-notice.js';
import { SALES_SERVICE } from '../../services/sales-service.js';
import { LOOKUP_SERVICE } from '../../services/lookup-service.js';

/** @import { Order, TableQuery } from '../../services/sales-service.js' */
/** @import { FilterRule, FilterState } from '@components/data/ui-dynamic-filter.js' */

/**
 * Fetch one order page for each table query. The resource cancels older requests
 * when paging, sorting, or filtering changes. Table state restores the layout and
 * filter values; rows always come from the server.
 */
export class OrdersPage extends SignalElement {
  /**
   * The query the resource reads for its next request.
   *
   * @type {TableQuery}
   */
  #query = { page: 1, pageSize: 20, sort: { key: '', direction: '' }, filters: [] };

  #page = resource(
    (signal) => inject(SALES_SERVICE).searchOrders(this.#query, signal),
    {
      initial: { rows: /** @type {Order[]} */ ([]), total: 0 },
      lifetime: () => this.lifetime,
    },
  );

  rows = computed(() => this.#page.value.value.rows);
  total = computed(() => this.#page.value.value.total);
  loading = this.#page.pending;
  failed = this.#page.failed;
  filters = signal(/** @type {readonly FilterState[]} */ ([]));

  /**
   * Rebuild translated filter labels when the language changes.
   *
   * @type {import('@core/foundation/types.js').ReadonlySignal<readonly FilterRule[]>}
   */
  #rules = computed(() => {
    const lookups = inject(LOOKUP_SERVICE);
    return [
      // Search all declared columns.
      { ref: ANY_COLUMN, type: 'free' },
      {
        // Fetch this short list when the filter connects.
        ref: 'status',
        type: 'observer',
        group: t('orders.status'),
        children: () => lookups.options('status').then((rows) => rows.map(translateStatus)),
      },
      {
        // Use the options already in this module.
        ref: 'channel',
        type: 'children',
        group: t('orders.channel'),
        multiple: true,
        children: ['direct', 'partner', 'web', 'edi'].map((value) => ({
          value,
          label: t(`orders.channelValue.${value}`),
        })),
      },
      {
        // Fetch this list when the row opens.
        ref: 'city',
        type: 'lazy',
        group: t('orders.city'),
        label: t('orders.loadCities'),
        children: () => lookups.options('city'),
      },
      {
        // Search municipalities by term and resolve saved ids to labels.
        ref: 'comuneId',
        type: 'typeahead',
        group: t('orders.comune'),
        label: t('orders.searchComune'),
        children: (term, context) => lookups.searchCities(term, context.signal),
        resolve: (values) => lookups.citiesByIds(values),
      },
      {
        ref: 'placedOn',
        type: 'daterange',
        group: t('orders.placedOn'),
        label: t('orders.customRange'),
        presets: [
          { label: t('orders.lastMonth'), value: lastDays(30) },
          { label: t('orders.lastQuarter'), value: lastDays(90) },
          { label: t('orders.thisYear'), value: sinceYearStart() },
        ],
        // The service maps this date range to two API parameters.
      },
    ];
  });

  get rules() {
    return this.#rules.value;
  }

  onMount() {
    // Load the default page now. Restored state can replace this request.
    void this.#page.reload();
  }

  /**
   * Use the query implied by restored table state.
   *
   * @param {Event} event
   */
  restore(event) {
    const detail = /** @type {CustomEvent<{ query?: TableQuery }>} */ (event).detail;
    if (detail.query !== undefined) void this.load(detail.query);
  }

  /** @param {Event} event */
  changeQuery(event) {
    void this.load(/** @type {CustomEvent<TableQuery>} */ (event).detail);
  }

  /**
   * Ignore an empty filter state that only changes array identity.
   *
   * @param {Event} event
   */
  applyFilters(event) {
    const next = /** @type {CustomEvent<readonly FilterState[]>} */ (event).detail;
    if (next.length === 0 && this.filters.value.length === 0) return;
    this.filters.value = next;
  }

  retry() {
    return this.#page.reload();
  }

  /** @param {TableQuery} query */
  load(query) {
    this.#query = query;
    return this.#page.reload();
  }

  /* ── Cell rendering ─────────────────────────────────────────────────────── */

  /**
   * Return text for a cell without interpreting it as markup.
   *
   * @param {unknown} row
   */
  renderTotal = (row) => {
    const order = /** @type {Order} */ (row);
    return cur(order.total, order.currency);
  };

  /**
   * The number the formatted amount is sorted and filtered by.
   *
   * @param {unknown} row
   */
  sortTotal = (row) => /** @type {Order} */ (row).total;

  /** @param {unknown} row */
  renderPlacedOn = (row) => dt(/** @type {Order} */ (row).placedOn, { dateStyle: 'medium' });

  /** @param {unknown} row */
  renderStatus = (row) => t(`orders.statusValue.${/** @type {Order} */ (row).status}`);

  /** @param {unknown} row */
  renderChannel = (row) => t(`orders.channelValue.${/** @type {Order} */ (row).channel}`);

  /**
   * Render a link in the order's detail cell.
   *
   * @param {unknown} row
   */
  renderCode = (row) => {
    const order = /** @type {Order} */ (row);
    const link = document.createElement('a');
    link.href = `/sales/orders/${order.id}`;
    link.className = 'font-medium text-brand hover:text-accent-strong';
    link.textContent = order.code;
    return link;
  };

  /** @param {unknown} row */
  rowKey = (row) => /** @type {Order} */ (row).id;
}

/**
 * @param {{ value: unknown, label: string }} option
 * @returns {{ value: unknown, label: string }}
 */
function translateStatus(option) {
  return { value: option.value, label: t(`orders.statusValue.${String(option.value)}`) };
}

/**
 * Return the last `days` days, including today, with an exclusive end tomorrow.
 *
 * @param {number} days
 */
function lastDays(days) {
  const today = new Date();
  const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - days);
  const until = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  return `${asDay(from)}${RANGE_SEPARATOR}${asDay(until)}`;
}

function sinceYearStart() {
  const today = new Date();
  const until = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  return `${String(today.getFullYear())}-01-01${RANGE_SEPARATOR}${asDay(until)}`;
}

/** @param {Date} date */
function asDay(date) {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

await defineComponent({
  tag: 'orders-page',
  element: OrdersPage,
  module: import.meta.url,
  uses: [AppCard, AppNotice, UiTable, UiTableColumn, UiDynamicFilter],
});
