import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { computed, signal } from '@core/foundation/reactive.js';
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
 * Customers: the client-paginated screen, and the one that uses `ui-combobox` directly.
 *
 * Forty-eight rows arrive in one request and `pagination="client"` filters, sorts and
 * slices them locally, so every interaction after the first is instant and costs no
 * round trip. The orders screen next door is the same table in `server` mode; the
 * difference between them is two attributes and where the work happens, which is the
 * reason both exist here.
 *
 * The filter is a searchable multi-select rather than `ui-dynamic-filter`, because this
 * screen filters on one field and a control holding one rule is a combobox. Its emitted
 * value becomes an ordinary filter descriptor with `match: 'equals'` — chosen
 * deliberately: with `contains`, selecting *smb* would also match nothing here, but
 * selecting *enterprise* in a list that also held *pre-enterprise* would match both.
 */
export class CustomersPage extends SignalElement {
  rows = signal(/** @type {readonly Customer[]} */ ([]));
  loading = signal(false);
  failed = signal(false);
  search = signal('');
  segments = signal(/** @type {readonly unknown[]} */ ([]));

  /** @type {AbortController | undefined} */
  #request;

  /**
   * The options, translated. A computed signal so a language change relabels them
   * without this screen refetching anything — the values are stable codes and only the
   * labels move.
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
   * The descriptors the table applies. Two of them at most: the text box and the
   * segment selection. Rebuilt as a computed value rather than assigned from event
   * handlers, so there is one definition of "what is filtered" instead of two writers
   * racing to keep a third signal correct.
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
   * `selection-change` carries the chosen options, not their values: the label is what
   * a chip renderer needs and the value is what a filter needs, so the element hands
   * over both and the consumer takes what it uses.
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

  onDestroy() {
    this.#request?.abort();
    this.#request = undefined;
  }

  async load() {
    this.#request?.abort();
    const request = new AbortController();
    this.#request = request;
    this.loading.value = true;
    this.failed.value = false;

    try {
      const result = await inject(SALES_SERVICE).customers(request.signal);
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

  /** Why the control is disabled, as a title. Empty when it is not. */
  get writeHint() {
    return this.canWrite ? '' : t('customers.needsWriteScope');
  }

  create() {
    void navigate('/sales/customers/new');
  }

  /**
   * The row's link to the customer.
   *
   * A plain link for everybody, because the detail screen opens in view mode and
   * needs only `sales:read` — the entitlement question moved to the Edit control
   * inside it. This used to render an em-dash for a session without `sales:write`,
   * since the only destination was the write route and offering a link that is
   * known to bounce to `/forbidden` is worse than not offering one.
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
