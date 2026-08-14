import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { computed, signal } from '@core/foundation/reactive.js';
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
 * Orders: the server-paginated screen.
 *
 * The table never sees more than one page. Every page, page-size, sort or filter change
 * arrives as one `query-change` event, goes out as one request, and comes back as
 * `{ rows, total }` — which is what `pagination="server"` means and why `total-rows` is
 * bound: the table cannot count what it does not have.
 *
 * FOUR THINGS THIS SCREEN IS THE EXAMPLE OF
 *
 *  1. **One in-flight request.** A user who types in a filter and pages twice fires
 *     three queries; the first two are aborted. Without that, the slowest response wins
 *     and the table shows a page nobody asked for.
 *  2. **Six kinds of filter rule, each for its real reason.** `free` for text,
 *     `observer` for a list worth having ready, `children` for one that is already
 *     known, `lazy` for one most sessions never open, `typeahead` for one nothing can
 *     download, `daterange` for a half-open interval.
 *  3. **Persistence that survives a reload.** `state-id` stores the page size, the
 *     sort, the column layout and — with `persist-filters` — the filter values, all
 *     through `@core/preferences/persistence.js`. The first fetch is issued from
 *     `state-restore` rather than from `onMount`, because firing both means one wasted
 *     request against the default state.
 *  4. **Rendered cells with their own sort and filter values.** The total is rendered
 *     as formatted currency, so `sort-value` gives the table the number to sort by.
 */
export class OrdersPage extends SignalElement {
  rows = signal(/** @type {readonly Order[]} */ ([]));
  total = signal(0);
  loading = signal(false);
  failed = signal(false);
  filters = signal(/** @type {readonly FilterState[]} */ ([]));

  /**
   * Rules are computed because every label in them is translated: a language change
   * produces a new array, and `ui-dynamic-filter` recompiles when the array identity
   * changes. Storing them in a field would freeze the labels at construction.
   *
   * @type {import('@core/foundation/types.js').ReadonlySignal<readonly FilterRule[]>}
   */
  #rules = computed(() => {
    const lookups = inject(LOOKUP_SERVICE);
    return [
      // Every declared column at once, so a free-text entry needs no predicate here
      // and no knowledge of which columns exist.
      { ref: ANY_COLUMN, type: 'free' },
      {
        // Short, always wanted: fetched once when the filter connects.
        ref: 'status',
        type: 'observer',
        group: t('orders.status'),
        children: () => lookups.options('status').then((rows) => rows.map(translateStatus)),
      },
      {
        // Known without asking anybody.
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
        // Longer, and most sessions never open it: fetched when its row is clicked.
        ref: 'city',
        type: 'lazy',
        group: t('orders.city'),
        label: t('orders.loadCities'),
        children: () => lookups.options('city'),
      },
      {
        // 8,600 municipalities. Never loaded as a list; one search at a time, and
        // `resolve` is what gives a value restored from storage its label back.
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
        // No `condition`: a `daterange` rule means a range comparison against the
        // column named by `ref`, and the service turns it into two query parameters.
      },
    ];
  });

  get rules() {
    return this.#rules.value;
  }

  /** @type {AbortController | undefined} */
  #request;

  /** @type {TableQuery | undefined} */
  #lastQuery;

  onMount() {
    // The first page, from this screen's own defaults. `state-restore` fires only when there
    // is something stored, so a screen that waited for it would show an empty table on a
    // first visit — and one that ignored it would show page one to somebody who left the
    // table on page four. Both happen here: this request goes out now, and a restore that
    // arrives immediately afterwards aborts it and asks for the right page instead.
    void this.load({ page: 1, pageSize: 20, sort: { key: '', direction: '' }, filters: [] });
  }

  /**
   * The table's restored state, carrying the query it implies.
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
   * `ui-table` returns to page one whenever `.filters` changes identity. That is right
   * for a filter change and wrong for the `filter-ready` that lands once slow rules
   * have loaded, so an empty state replacing an empty state is ignored.
   *
   * @param {Event} event
   */
  applyFilters(event) {
    const next = /** @type {CustomEvent<readonly FilterState[]>} */ (event).detail;
    if (next.length === 0 && this.filters.value.length === 0) return;
    this.filters.value = next;
  }

  retry() {
    if (this.#lastQuery !== undefined) void this.load(this.#lastQuery);
  }

  /** @param {TableQuery} query */
  async load(query) {
    this.#lastQuery = query;
    this.#request?.abort();
    const request = new AbortController();
    this.#request = request;
    this.loading.value = true;
    this.failed.value = false;

    try {
      const result = await inject(SALES_SERVICE).searchOrders(query, request.signal);
      if (request.signal.aborted) return;
      this.rows.value = result.rows;
      this.total.value = result.total;
    } catch {
      if (!request.signal.aborted) this.failed.value = true;
    } finally {
      if (this.#request === request) {
        this.loading.value = false;
        this.#request = undefined;
      }
    }
  }

  onDestroy() {
    this.#request?.abort();
    this.#request = undefined;
  }

  /* ── Cell rendering ─────────────────────────────────────────────────────── */

  /**
   * A renderer returns text, a DOM node or a Lit template result. Returning a string
   * keeps it text, which is what makes the escaping question not arise.
   *
   * @param {unknown} row
   */
  renderTotal = (row) => {
    const order = /** @type {Order} */ (row);
    return cur(order.total, order.currency);
  };

  /**
   * The number behind the rendered amount. Orthogonal to the renderer on purpose: the
   * cell says "€ 1.234,50" and this is what sorting and filtering compare.
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
   * The row's link. A rendered cell rather than an `interactive` table, because one
   * cell being a link is honest markup and a clickable row is a `div` pretending.
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
 * A half-open interval ending tomorrow, which is what "the last 30 days, including
 * today" is once the end is exclusive. The conversion between inclusive labels and the
 * exclusive bound happens in `ui-date-range` for the custom row; a preset states the
 * stored form directly.
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
