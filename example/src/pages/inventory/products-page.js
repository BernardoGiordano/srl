import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { computed, signal } from '@core/foundation/reactive.js';
import { resource } from '@core/foundation/resource.js';
import { inject } from '@core/foundation/inject.js';
import { cur, dt, t } from '@core/localization/i18n.js';
import { ANY_COLUMN } from '@components/data/filter-descriptor.js';
import { UiTable } from '@components/data/ui-table.js';
import { UiTableColumn } from '@components/data/ui-table-column.js';
import { UiDynamicFilter } from '@components/data/ui-dynamic-filter.js';

import { AppCard } from '../../ui/app-card.js';
import { AppBadge } from '../../ui/app-badge.js';
import { AppNotice } from '../../ui/app-notice.js';
import { INVENTORY_SERVICE } from '../../services/inventory-service.js';
import { LOOKUP_SERVICE } from '../../services/lookup-service.js';

/** @import { Product } from '../../services/inventory-service.js' */
/** @import { FilterRule, FilterState } from '@components/data/ui-dynamic-filter.js' */

/**
 * Append product pages as the table asks for more rows. A new sort or filter resets
 * the list because its rows belong to a different query. Table preferences persist
 * the layout and filters, while the products are fetched again.
 */
export class ProductsPage extends SignalElement {
  /** The query the accumulated rows belong to. */
  #query = {
    offset: 0,
    limit: 25,
    sort: /** @type {{ key: string, direction: 'asc' | 'desc' | '' }} */ ({ key: '', direction: '' }),
  };

  /**
   * Fetch one window and append its rows to this screen's list.
   */
  #window = resource(
    (signal) =>
      inject(INVENTORY_SERVICE).products(
        {
          offset: this.#query.offset,
          limit: this.#query.limit,
          sort: this.#query.sort,
          filters: this.filters.value,
        },
        signal,
      ),
    {
      initial: { rows: /** @type {Product[]} */ ([]), total: 0, offset: 0 },
      lifetime: () => this.lifetime,
    },
  );

  rows = signal(/** @type {readonly Product[]} */ ([]));
  total = signal(0);
  loading = this.#window.pending;
  failed = this.#window.failed;
  filters = signal(/** @type {readonly FilterState[]} */ ([]));

  /** @type {import('@core/foundation/types.js').ReadonlySignal<readonly FilterRule[]>} */
  #rules = computed(() => {
    const lookups = inject(LOOKUP_SERVICE);
    return [
      { ref: ANY_COLUMN, type: 'free' },
      {
        ref: 'category',
        type: 'observer',
        group: t('products.category'),
        multiple: true,
        children: () =>
          lookups
            .options('category')
            .then((rows) =>
              rows.map((row) => ({ value: row.value, label: t(`products.categoryValue.${String(row.value)}`) })),
            ),
      },
      {
        ref: 'warehouse',
        type: 'lazy',
        group: t('products.warehouse'),
        label: t('products.loadWarehouses'),
        multiple: true,
        children: () => lookups.options('warehouse'),
      },
      {
        // The API reads this single-option rule as a boolean.
        ref: 'belowReorder',
        type: 'option',
        group: t('products.stock'),
        label: t('products.belowReorderOnly'),
        value: 'true',
      },
    ];
  });

  get rules() {
    return this.#rules.value;
  }

  get loaded() {
    return this.rows.value.length;
  }

  get countLabel() {
    return t('products.loadedCount', { loaded: this.loaded, total: this.total.value });
  }

/** Whether another page is available. */
  get complete() {
    return this.loaded >= this.total.value;
  }

  onMount() {
    // Fetch the first page when there is no saved table state.
    void this.reset({ limit: 25, sort: { key: '', direction: '' } });
  }

  /** @param {Event} event */
  restore(event) {
    const detail = /** @type {CustomEvent<{ query?: { pageSize?: number, sort?: { key: string, direction: 'asc' | 'desc' | '' } } }>} */ (
      event
    ).detail;
    const query = detail.query;
    void this.reset({
      limit: query?.pageSize ?? 25,
      sort: query?.sort ?? { key: '', direction: '' },
    });
  }

  /**
   * Start a new list for a page, sort, or filter change.
   *
   * @param {Event} event
   */
  changeQuery(event) {
    const detail = /** @type {CustomEvent<{ pageSize: number, sort: { key: string, direction: 'asc' | 'desc' | '' } }>} */ (
      event
    ).detail;
    void this.reset({ limit: detail.pageSize, sort: detail.sort });
  }

/** Load the next page on scroll or button activation. */
  loadMore() {
    if (this.loading.value || this.complete) return;
    void this.fetch(this.loaded, false);
  }

  retry() {
    void this.fetch(this.#query.offset, this.#query.offset === 0);
  }

  /** @param {{ limit: number, sort: { key: string, direction: 'asc' | 'desc' | '' } }} next */
  async reset(next) {
    this.#query = { offset: 0, limit: next.limit, sort: next.sort };
    await this.fetch(0, true);
  }

  /**
   * @param {number} offset
   * @param {boolean} replace
   */
  async fetch(offset, replace) {
    this.#query = { ...this.#query, offset };

    const page = await this.#window.reload();
    // Keep current rows when the new request produces no data.
    if (page === undefined) return;

    this.rows.value = replace ? page.rows : [...this.rows.value, ...page.rows];
    this.total.value = page.total;
  }

  /** @param {Event} event */
  applyFilters(event) {
    const next = /** @type {CustomEvent<readonly FilterState[]>} */ (event).detail;
    if (next.length === 0 && this.filters.value.length === 0) return;
    this.filters.value = next;
    void this.reset({ limit: this.#query.limit, sort: this.#query.sort });
  }

  /* ── Cells ──────────────────────────────────────────────────────────────── */

  /** @param {unknown} row */
  sortStock = (row) => /** @type {Product} */ (row).stock;

  /** @param {unknown} row */
  renderPrice = (row) => cur(/** @type {Product} */ (row).price, 'EUR');

  /** @param {unknown} row */
  sortPrice = (row) => /** @type {Product} */ (row).price;

  /** @param {unknown} row */
  renderCategory = (row) => t(`products.categoryValue.${/** @type {Product} */ (row).category}`);

  /** @param {unknown} row */
  renderUpdatedAt = (row) => dt(/** @type {Product} */ (row).updatedAt, { dateStyle: 'short', timeStyle: 'short' });

  /** @param {unknown} row */
  rowKey = (row) => /** @type {Product} */ (row).sku;
}

await defineComponent({
  tag: 'products-page',
  element: ProductsPage,
  module: import.meta.url,
  uses: [AppCard, AppBadge, AppNotice, UiTable, UiTableColumn, UiDynamicFilter],
});
