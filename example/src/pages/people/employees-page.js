import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { computed, signal } from '@core/foundation/reactive.js';
import { resource } from '@core/foundation/resource.js';
import { inject } from '@core/foundation/inject.js';
import { dt, t } from '@core/localization/i18n.js';
import { ANY_COLUMN, RANGE_SEPARATOR } from '@components/data/filter-descriptor.js';
import { UiTable } from '@components/data/ui-table.js';
import { UiTableColumn } from '@components/data/ui-table-column.js';
import { UiDynamicFilter } from '@components/data/ui-dynamic-filter.js';
import { UiAvatar } from '@components/shell/ui-avatar.js';

import { AppCard } from '../../ui/app-card.js';
import { AppNotice } from '../../ui/app-notice.js';
import { PEOPLE_SERVICE } from '../../services/people-service.js';
import { LOOKUP_SERVICE } from '../../services/lookup-service.js';

/** @import { Employee } from '../../services/people-service.js' */
/** @import { FilterRule, FilterState } from '@components/data/ui-dynamic-filter.js' */

/**
 * The staff directory.
 *
 * Client pagination over one request, like the customers screen, and a rendered name cell
 * that mounts a `ui-avatar` — the collection's own element, inside a table cell, built by
 * a renderer. That is the shape a "rich cell" takes here: a function returning a node,
 * not a template the table has to interpret.
 *
 * The `daterange` rule filters the hire date. Its presets are the interesting part: the
 * stored interval is half-open, so "the last two years" ends *tomorrow*, and a preset
 * marked `default: true` would apply on every visit without being written back. None is
 * marked here, because a directory that silently hides half the company on first load is
 * a support ticket.
 */
export class EmployeesPage extends SignalElement {
  #employees = resource(
    (signal) => inject(PEOPLE_SERVICE).employees(signal).then((result) => result.rows),
    { initial: /** @type {Employee[]} */ ([]), lifetime: () => this.lifetime },
  );

  rows = this.#employees.value;
  loading = this.#employees.pending;
  failed = this.#employees.failed;
  filters = signal(/** @type {readonly FilterState[]} */ ([]));

  /** @type {import('@core/foundation/types.js').ReadonlySignal<readonly FilterRule[]>} */
  #rules = computed(() => {
    const lookups = inject(LOOKUP_SERVICE);
    return [
      { ref: ANY_COLUMN, type: 'free' },
      {
        ref: 'team',
        type: 'children',
        group: t('people.team'),
        multiple: true,
        children: ['Engineering', 'Operations', 'Sales', 'Customer care', 'Finance', 'Product'].map((value) => ({
          value,
          label: value,
        })),
      },
      {
        ref: 'location',
        type: 'observer',
        group: t('people.location'),
        multiple: true,
        children: () => lookups.options('location'),
      },
      {
        ref: 'role',
        type: 'lazy',
        group: t('people.role'),
        label: t('people.loadRoles'),
        multiple: true,
        children: () => lookups.options('role'),
      },
      {
        ref: 'status',
        type: 'boolean',
        group: t('people.status'),
        label: t('people.onLeaveOnly'),
        value: true,
        // A `boolean` rule's value is `true`, and this column holds a word, so the
        // comparison is spelled out. `condition` is the escape hatch for exactly this:
        // a rule whose meaning is not "equals the column named by ref".
        condition: (row) => /** @type {Employee} */ (row).status === 'leave',
      },
      {
        ref: 'hiredOn',
        type: 'daterange',
        group: t('people.hiredOn'),
        label: t('people.customRange'),
        presets: [
          { label: t('people.hiredRecently'), value: lastYears(2) },
          { label: t('people.hiredLongAgo'), value: beforeYears(5) },
        ],
      },
    ];
  });

  get rules() {
    return this.#rules.value;
  }

  onMount() {
    void this.load();
  }

  load() {
    return this.#employees.reload();
  }

  /** @param {Event} event */
  applyFilters(event) {
    const next = /** @type {CustomEvent<readonly FilterState[]>} */ (event).detail;
    if (next.length === 0 && this.filters.value.length === 0) return;
    this.filters.value = next;
  }

  /**
   * An avatar, the name as a link, and the email under it. Three nodes, so the renderer
   * builds them rather than returning a string.
   *
   * @param {unknown} row
   */
  renderName = (row) => {
    const employee = /** @type {Employee} */ (row);

    const wrapper = document.createElement('span');
    wrapper.className = 'flex min-w-0 items-center gap-2.5';

    const avatar = document.createElement('ui-avatar');
    avatar.setAttribute('name', employee.name);
    avatar.setAttribute(
      'fallback-class',
      'flex size-8 shrink-0 items-center justify-center rounded-full bg-brand text-[11px] font-semibold text-brand-contrast',
    );
    wrapper.append(avatar);

    const text = document.createElement('span');
    text.className = 'min-w-0';

    const link = document.createElement('a');
    link.href = `/people/employees/${employee.id}`;
    link.className = 'block truncate font-medium text-brand hover:text-accent-strong';
    link.textContent = employee.name;

    const email = document.createElement('span');
    email.className = 'block truncate text-[11.5px] text-muted';
    email.textContent = employee.email;

    text.append(link, email);
    wrapper.append(text);
    return wrapper;
  };

  /** The plain name, so sorting and free-text search do not see the markup. */
  /** @param {unknown} row */
  nameValue = (row) => /** @type {Employee} */ (row).name;

  /** @param {unknown} row */
  renderHiredOn = (row) => dt(/** @type {Employee} */ (row).hiredOn, { dateStyle: 'medium' });

  /** @param {unknown} row */
  renderStatus = (row) => t(`people.statusValue.${/** @type {Employee} */ (row).status}`);

  /** @param {unknown} row */
  rowKey = (row) => /** @type {Employee} */ (row).id;
}

/**
 * The last `years` years, ending tomorrow because the stored end is exclusive.
 *
 * @param {number} years
 */
function lastYears(years) {
  const today = new Date();
  const from = new Date(today.getFullYear() - years, today.getMonth(), today.getDate());
  const until = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  return `${asDay(from)}${RANGE_SEPARATOR}${asDay(until)}`;
}

/**
 * Everything before `years` years ago.
 *
 * @param {number} years
 */
function beforeYears(years) {
  const today = new Date();
  const until = new Date(today.getFullYear() - years, today.getMonth(), today.getDate());
  return `1970-01-01${RANGE_SEPARATOR}${asDay(until)}`;
}

/** @param {Date} date */
function asDay(date) {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

await defineComponent({
  tag: 'employees-page',
  element: EmployeesPage,
  module: import.meta.url,
  uses: [AppCard, AppNotice, UiTable, UiTableColumn, UiDynamicFilter, UiAvatar],
});
