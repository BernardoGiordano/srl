import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { computed, signal } from '@core/foundation/reactive.js';
import { resource } from '@core/foundation/resource.js';
import { inject } from '@core/foundation/inject.js';
import { navigate } from '@core/navigation/router.js';
import { cur, dt, num, t } from '@core/localization/i18n.js';
import { AUTH_SESSION } from '@auth/session.js';
import { ANY_COLUMN } from '@components/data/filter-descriptor.js';
import { UiTable } from '@components/data/ui-table.js';
import { UiTableColumn } from '@components/data/ui-table-column.js';
import { UiCombobox } from '@components/inputs/ui-combobox.js';

import { AppCard } from '../../ui/app-card.js';
import { AppNotice } from '../../ui/app-notice.js';
import { SALES_SERVICE } from '../../services/sales-service.js';

/** @import { Customer } from '../../services/sales-service.js' */
/** @import { ComboboxOption } from '@components/inputs/ui-combobox.js' */

/**
 * Load all customers once and let the table page them locally. A searchable
 * combobox filters segments with exact matches.
 */
export class CustomersPage extends SignalElement {
  #customers = resource(
    (signal) => inject(SALES_SERVICE).customers(signal).then((result) => result.rows),
    { initial: /** @type {Customer[]} */ ([]), lifetime: () => this.lifetime },
  );

  rows = this.#customers.value;
  loading = this.#customers.pending;
  failed = this.#customers.failed;
  search = signal('');
  segments = signal(/** @type {readonly unknown[]} */ ([]));

  /**
   * Translate option labels when the language changes.
   *
   * @type {import('@core/foundation/types.js').ReadonlySignal<readonly ComboboxOption[]>}
   */
  #segmentOptions = computed(() =>
    ['enterprise', 'midmarket', 'smb', 'public'].map((value) => ({
      value,
      label: t(`customers.segmentValue.${value}`),
    })),
  );

  get segmentOptions() {
    return this.#segmentOptions.value;
  }

  /**
   * Derive table filters from search text and selected segments.
   *
   * @type {import('@core/foundation/types.js').ReadonlySignal<readonly { key: string, value: unknown, match?: 'equals' }[]>}
   */
  #filters = computed(() => {
    /** @type {{ key: string, value: unknown, match?: 'equals' }[]} */
    const filters = [];
    const term = this.search.value.trim();
    if (term !== '') filters.push({ key: ANY_COLUMN, value: term });
    const chosen = this.segments.value;
    if (chosen.length > 0) filters.push({ key: 'segment', value: chosen, match: 'equals' });
    return filters;
  });

  get filters() {
    return this.#filters.value;
  }

  /** @param {Event} event */
  changeSearch(event) {
    if (event.target instanceof HTMLInputElement) this.search.value = event.target.value;
  }

  /**
   * Read filter values from the chosen combobox options.
   *
   * @param {Event} event
   */
  changeSegments(event) {
    const chosen = /** @type {CustomEvent<readonly ComboboxOption[]>} */ (event).detail;
    this.segments.value = chosen.map((option) => option.value);
  }

  onMount() {
    void this.load();
  }

  load() {
    return this.#customers.reload();
  }

  /** @param {unknown} row */
  renderRevenue = (row) => cur(/** @type {Customer} */ (row).revenue, 'EUR');

  /** @param {unknown} row */
  sortRevenue = (row) => /** @type {Customer} */ (row).revenue;

  /** @param {unknown} row */
  renderSince = (row) => dt(/** @type {Customer} */ (row).since, { dateStyle: 'medium' });

  /** @param {unknown} row */
  renderSegment = (row) => t(`customers.segmentValue.${/** @type {Customer} */ (row).segment}`);

  /** @param {unknown} row */
  renderOpenOrders = (row) => num(/** @type {Customer} */ (row).openOrders);

  /** @param {unknown} row */
  rowKey = (row) => /** @type {Customer} */ (row).id;

  /* ── The write path ─────────────────────────────────────────────────────── */

  get canWrite() {
    return inject(AUTH_SESSION).scopes.value.includes('sales:write');
  }

/** Explain why the control is disabled. */
  get writeHint() {
    return this.canWrite ? '' : t('customers.needsWriteScope');
  }

  create() {
    void navigate('/sales/customers/new');
  }

  /**
   * Link to a customer's read-only detail screen.
   *
   * @param {unknown} row
   */
  renderAction = (row) => {
    const customer = /** @type {Customer} */ (row);
    const link = document.createElement('a');
    link.href = `/sales/customers/${encodeURIComponent(customer.id)}`;
    link.className = 'font-semibold text-accent underline-offset-2 hover:underline';
    link.textContent = t('customers.open');
    return link;
  };
}

await defineComponent({
  tag: 'customers-page',
  element: CustomersPage,
  module: import.meta.url,
  uses: [AppCard, AppNotice, UiTable, UiTableColumn, UiCombobox],
});
