import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { computed, signal } from '@core/foundation/reactive.js';
import { inject } from '@core/foundation/inject.js';
import { cur, dt, num, t } from '@core/localization/i18n.js';
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
 * Products: the infinite-scroll screen.
 *
 * `pagination="infinite"` appends instead of replacing, so this page holds the rows it
 * has accumulated and adds to them. Two consequences the other two table screens do not
 * have:
 *
 *  - **`load-more` carries an offset, and the accumulated rows are the state.** A page
 *    number would be ambiguous the moment a filter changed under it.
 *  - **A filter or sort change resets the accumulation.** The table emits
 *    `query-change` with `offset: 0`; anything already appended belongs to the previous
 *    query and has to go, or the list becomes two queries stacked on top of each other.
 *
 * `state-id` persists the column layout and the sort, and `persist-filters` the filter
 * values — but never the rows, which is the one thing table state deliberately does not
 * store.
 *
 * The stock column is a rendered cell with a badge in it: a renderer may return a DOM
 * node, so "below reorder point" is visible rather than something the reader has to
 * work out by comparing two columns.
 */
export class ProductsPage extends SignalElement {
  rows = signal(/** @type {readonly Product[]} */ ([]));
  total = signal(0);
  loading = signal(false);
  failed = signal(false);
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
        // A single-option rule: on or off, one value. The API takes it as a boolean.
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

  /** @type {AbortController | undefined} */
  #request;

  /** The query the accumulated rows belong to. */
  #query = { offset: 0, limit: 25, sort: /** @type {{ key: string, direction: 'asc' | 'desc' | '' }} */ ({ key: '', direction: '' }) };

  get loaded() {
    return this.rows.value.length;
  }

  get countLabel() {
    return t('products.loadedCount', { loaded: this.loaded, total: this.total.value });
  }

  /** Whether there is anything left to fetch. Drives the table's own load-more affordance. */
  get complete() {
    return this.loaded >= this.total.value;
  }

  onMount() {
    // The first window. As on the orders screen, `state-restore` fires only when something
    // was stored, so this is the first-visit path and a restore that follows supersedes it.
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
   * A page, sort or filter change. Every one of them starts the list again, because the
   * rows already appended answered a different question.
   *
   * @param {Event} event
   */
  changeQuery(event) {
    const detail = /** @type {CustomEvent<{ pageSize: number, sort: { key: string, direction: 'asc' | 'desc' | '' } }>} */ (
      event
    ).detail;
    void this.reset({ limit: detail.pageSize, sort: detail.sort });
  }

  /** The sentinel scrolled into view, or the accessible button was pressed. */
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
    this.#request?.abort();
    const request = new AbortController();
    this.#request = request;
    this.#query = { ...this.#query, offset };
    this.loading.value = true;
    this.failed.value = false;

    try {
      const result = await inject(INVENTORY_SERVICE).products(
        { offset, limit: this.#query.limit, sort: this.#query.sort, filters: this.filters.value },
        request.signal,
      );
      if (request.signal.aborted) return;
      this.rows.value = replace ? result.rows : [...this.rows.value, ...result.rows];
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

  /** @param {Event} event */
  applyFilters(event) {
    const next = /** @type {CustomEvent<readonly FilterState[]>} */ (event).detail;
    if (next.length === 0 && this.filters.value.length === 0) return;
    this.filters.value = next;
    void this.reset({ limit: this.#query.limit, sort: this.#query.sort });
  }

  onDestroy() {
    this.#request?.abort();
    this.#request = undefined;
  }

  /* ── Cells ──────────────────────────────────────────────────────────────── */

  /** @param {unknown} row */
  renderStock = (row) => {
    const product = /** @type {Product} */ (row);
    const wrapper = document.createElement('span');
    wrapper.className = 'flex items-center justify-end gap-2 tabular-nums';

    const count = document.createElement('span');
    count.textContent = num(product.stock);
    wrapper.append(count);

    if (product.stock < product.reorderPoint) {
      // `app-badge` is a defined element, so creating it here mounts a real component:
      // a renderer may return any node, and the node may be one of ours.
      const badge = document.createElement('app-badge');
      badge.setAttribute('tone', 'bad');
      badge.textContent = t('products.low');
      wrapper.append(badge);
    }
    return wrapper;
  };

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
