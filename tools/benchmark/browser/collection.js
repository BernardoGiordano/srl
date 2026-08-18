/**
 * Shared-collection workloads: the table and the combobox, driven the way a screen
 * drives them.
 *
 * Every one of these goes through the element's public interface — set `rows`, set
 * `filters`, type into the search field — and asserts on rendered DOM before its
 * timing counts. That is deliberate: the table's internals are the thing a later
 * phase may rewrite behind a projection or a visible-row window, and a benchmark
 * that reached into them would have to be rewritten alongside, which is how a
 * before/after comparison stops being a comparison.
 *
 * The row counts are 100, 1,000 and 10,000, with 50 visible in the paginated case,
 * plus the full 10,000-row render that produced the ~398,000 DOM nodes the first
 * measurements reported. ADR-0037. Column counts are 4 by default, so 10,000 rows
 * is 40,000 cells and the figures are comparable with those.
 */

import '@components/data/ui-table.js';
import '@components/inputs/ui-combobox.js';

import { expect, makeRows, rendered, waitFor } from './support.js';

/** @import { UiTable } from '@components/data/ui-table.js' */
/** @import { UiCombobox } from '@components/inputs/ui-combobox.js' */
/** @import { Row } from './support.js' */

/**
 * The visible columns for every table workload that does not say otherwise.
 *
 * `read` exists so a wide table can copy a column's value onto the row under a
 * second key. See `wideRows`.
 *
 * @type {readonly {
 *   key: string,
 *   label: string,
 *   sortable: boolean,
 *   read: (row: Row) => unknown,
 * }[]}
 */
const COLUMNS = [
  { key: 'name', label: 'Name', sortable: true, read: (row) => row.name },
  { key: 'email', label: 'Email', sortable: true, read: (row) => row.email },
  { key: 'meta.team', label: 'Team', sortable: true, read: (row) => row.meta.team },
  { key: 'meta.city', label: 'City', sortable: false, read: (row) => row.meta.city },
];

/**
 * The declared column a wide table's column at `index` repeats.
 *
 * @param {number} index
 * @returns {(typeof COLUMNS)[number]}
 */
function sourceColumn(index) {
  const source = COLUMNS[index % COLUMNS.length];
  if (source === undefined) throw new Error('COLUMNS is empty.');
  return source;
}

/**
 * The `key` attribute of the column at `index`.
 *
 * The first four name row fields directly; every one past them names the copy
 * `wideRows` puts on the row. Distinctness is not cosmetic: `<ui-table>` keys its
 * column order, hidden set, widths, sticky sides and measured header widths by
 * `column.key`, so repeating a key makes twenty-four columns share four sets of
 * everything — four measured widths, four sticky offsets — and the wide-table
 * workloads stop measuring a wide table.
 *
 * @param {number} index
 * @returns {string}
 */
function columnKeyAt(index) {
  return index < COLUMNS.length ? sourceColumn(index).key : `copy${String(index)}`;
}

/**
 * Copy each repeated column's value onto the row under that column's own key.
 *
 * That is what makes "many columns, one row object" true rather than merely
 * commented: every cell renders the same text it rendered when the keys were
 * duplicated, and the columns rendering it are now distinct to the table. Called
 * from `setup`, so the copying is untimed.
 *
 * @param {readonly Row[]} rows
 * @param {number} columnCount
 * @returns {readonly Record<string, unknown>[]}
 */
function wideRows(rows, columnCount) {
  if (columnCount <= COLUMNS.length) return rows;
  return rows.map((row) => {
    /** @type {Record<string, unknown>} */
    const wide = { ...row };
    for (let index = COLUMNS.length; index < columnCount; index += 1) {
      wide[columnKeyAt(index)] = sourceColumn(index).read(row);
    }
    return wide;
  });
}

/**
 * Build a `<ui-table>` with its columns, attribute by attribute.
 *
 * No markup string anywhere: the benchmark page enforces the production Trusted
 * Types policy list, which has no policy that would let a fixture set `innerHTML`.
 * Building the element tree is also closer to what a compiled template does.
 *
 * @param {HTMLElement} container
 * @param {{ columns?: number, sticky?: number, pageSize?: number, pagination?: string }} options
 * @returns {UiTable}
 */
function buildTable(container, options) {
  const columnCount = options.columns ?? COLUMNS.length;
  const sticky = options.sticky ?? 0;

  const table = /** @type {UiTable} */ (document.createElement('ui-table'));
  table.setAttribute('page-size', String(options.pageSize ?? 50));
  table.setAttribute('page-sizes', '50,100');
  table.setAttribute('pagination', options.pagination ?? 'client');
  // Accessible names are part of the interface, so the fixture supplies them
  // rather than rendering a table no screen reader could use.
  table.setAttribute('empty-label', 'Empty');
  table.setAttribute('loading-label', 'Loading');
  table.setAttribute('pagination-label', 'Pages');
  table.setAttribute('previous-label', 'Previous');
  table.setAttribute('next-label', 'Next');
  table.setAttribute('page-size-label', 'Rows');
  table.setAttribute('load-more-label', 'More');
  table.setAttribute('sort-ascending-label', 'Sort ascending by');
  table.setAttribute('sort-descending-label', 'Sort descending by');
  table.setAttribute('clear-sort-label', 'Clear sort for');

  for (let index = 0; index < columnCount; index += 1) {
    const source = sourceColumn(index);
    const column = document.createElement('ui-table-column');
    // Columns past the first four repeat the same data under a distinct key, which
    // is what a wide table looks like: many columns, one row object. `wideRows`
    // supplies the value each repeated key reads.
    column.setAttribute('key', columnKeyAt(index));
    column.setAttribute('label', `${source.label} ${String(index)}`);
    if (source.sortable) column.setAttribute('sortable', '');
    if (index < sticky) column.setAttribute('sticky', 'start');
    else if (index >= columnCount - sticky) column.setAttribute('sticky', 'end');
    table.append(column);
  }

  container.append(table);
  return table;
}

/**
 * @param {UiTable} table
 * @returns {number}
 */
function renderedRows(table) {
  return table.querySelectorAll('[data-ui-part="table-row"]').length;
}

/**
 * Header and body cells that are actually stuck to an edge.
 *
 * `[data-sticky]` on its own matches every cell in the table: the template binds
 * `[data-sticky]="columnSticky(column)"`, a column that is not sticky answers with
 * the empty string, and an empty attribute is still an attribute that is present.
 * The value has to be part of the selector.
 *
 * @param {UiTable} table
 * @returns {number}
 */
function stickyCells(table) {
  return table.querySelectorAll('[data-sticky="start"],[data-sticky="end"]').length;
}

/**
 * Mount a paginated client table: `rows` owned rows, `pageSize` of them on screen.
 *
 * The cheap case, and the one a real screen is in. Review2 measured 24 ms for
 * 10,000 rows at 50 visible, which is the figure this workload turns into a
 * repeatable median.
 *
 * @type {import('./support.js').Workload}
 */
export const table_mount = {
  setup(scope, args) {
    return {
      table: buildTable(scope.container, { pageSize: Number(args.pageSize) }),
      rows: makeRows(Number(args.rows)),
      pageSize: Number(args.pageSize),
    };
  },
  async run(state) {
    state.table.rows = state.rows;
    await rendered(state.table);
    return renderedRows(state.table);
  },
  check(answer, args) {
    expect(answer, Number(args.pageSize), 'visible rows');
  },
};

/**
 * Filter `rows` owned rows down to the ones matching a substring, with the visible
 * page bounded, so the timing is the filter rather than the render.
 *
 * @type {import('./support.js').Workload}
 */
export const table_filter = {
  async setup(scope, args) {
    const table = buildTable(scope.container, { pageSize: 50 });
    table.rows = makeRows(Number(args.rows));
    await rendered(table);
    return { table, generation: 0 };
  },
  async run(state) {
    // A different term per sample, so no cache anywhere can answer twice.
    state.generation += 1;
    const term = `Person ${String(state.generation)}`;
    state.table.filters = [{ key: 'name', value: term, match: 'contains' }];
    await rendered(state.table);
    await waitFor(() => renderedRows(state.table) > 0, 'the filtered rows');
    return state.table.querySelector('[data-ui-part="table-row"]')?.textContent?.includes(term);
  },
  check(answer) {
    expect(answer, true, 'the first filtered row matches the term');
  },
};

/**
 * Sort `rows` owned rows, page still bounded.
 *
 * @type {import('./support.js').Workload}
 */
export const table_sort = {
  async setup(scope, args) {
    const table = buildTable(scope.container, { pageSize: 50 });
    table.rows = makeRows(Number(args.rows));
    await rendered(table);
    return { table, direction: 'asc' };
  },
  async run(state) {
    state.direction = state.direction === 'asc' ? 'desc' : 'asc';
    state.table.sortKey = 'name';
    state.table.sortDirection = state.direction;
    await rendered(state.table);
    return state.table.getAttribute('sort-direction');
  },
  check(answer) {
    expect(answer === 'asc' || answer === 'desc', true, 'the reflected sort direction');
  },
};

/**
 * Render every row at once: `pagination="none"`, 10,000 rows, 40,000 cells.
 *
 * The worst case the table supports, and the one that would decide whether row
 * windowing is needed. ADR-0044. Its DOM node count is reported as a metric
 * alongside the timing, because 583 ms and 398,000 nodes are one fact, not two.
 *
 * @type {import('./support.js').Workload}
 */
export const table_full_render = {
  measured: true,
  setup(scope, args) {
    return {
      table: buildTable(scope.container, { pagination: 'none' }),
      rows: makeRows(Number(args.rows)),
    };
  },
  async run(state) {
    const started = performance.now();
    state.table.rows = state.rows;
    await rendered(state.table);
    const elapsed = performance.now() - started;
    const cells = state.table.querySelectorAll('td').length;
    return {
      answer: { rows: renderedRows(state.table), cells },
      metrics: { render: elapsed, cells },
    };
  },
  check(answer, args) {
    const rows = Number(args.rows);
    expect(answer.rows, rows, 'rendered rows');
    expect(answer.cells, rows * COLUMNS.length, 'rendered cells');
  },
};

/**
 * Reverse a fully rendered keyed list of `rows` rows.
 *
 * `rowKey` defaults to `id`, so this is the keyed path: the table should move rows
 * rather than rebuild them. The check asserts the first row is the one that used to
 * be last, which is the cheapest observable proof that the reorder actually
 * happened before the clock stopped.
 *
 * @type {import('./support.js').Workload}
 */
export const table_reorder = {
  async setup(scope, args) {
    const count = Number(args.rows);
    const table = buildTable(scope.container, { pagination: 'none' });
    const rows = makeRows(count);
    table.rows = rows;
    await rendered(table);
    return { table, rows, count, flipped: false };
  },
  async run(state) {
    state.flipped = !state.flipped;
    state.table.rows = state.flipped ? [...state.rows].reverse() : state.rows;
    await rendered(state.table);
    const first = state.table.querySelector('[data-ui-part="table-row"]');
    return first?.textContent?.includes(
      `Person ${String(state.flipped ? state.count : 1)}`,
    );
  },
  check(answer) {
    expect(answer, true, 'the reordered first row');
  },
};

/**
 * A wide table with sticky columns at both edges.
 *
 * Sticky offsets are computed from the widths of the columns before them, so the
 * cost is a function of how many are sticky and how many columns they have to walk
 * past. Run at a realistic count and at a deliberately hostile one.
 *
 * `sticky` is a count per edge: the first `sticky` columns stick to the start and
 * the last `sticky` to the end, so the table has twice that many sticky columns
 * unless the two ends overlap.
 *
 * @type {import('./support.js').Workload}
 */
export const table_sticky = {
  setup(scope, args) {
    const columns = Number(args.columns);
    return {
      table: buildTable(scope.container, {
        columns,
        sticky: Number(args.sticky),
        pageSize: 50,
      }),
      rows: wideRows(makeRows(Number(args.rows)), columns),
      columns,
    };
  },
  async run(state) {
    state.table.rows = state.rows;
    await rendered(state.table);
    return { rows: renderedRows(state.table), stuck: stickyCells(state.table) };
  },
  check(answer, args) {
    const rows = Math.min(Number(args.rows), 50);
    // The union of the two edges, which is every column once they meet.
    const stickyColumns = Math.min(2 * Number(args.sticky), Number(args.columns));
    expect(answer.rows, rows, 'visible rows');
    // One header cell per sticky column plus one body cell per rendered row: the
    // offsets this workload exists to measure are only real if they were applied.
    expect(answer.stuck, stickyColumns * (rows + 1), 'sticky header and body cells');
  },
};

/**
 * Type into a combobox holding `options` local options and wait for the filtered
 * list.
 *
 * Through the input element, not through the internal search state: the question is
 * what a person typing into a 1,000-option combobox experiences.
 *
 * @type {import('./support.js').Workload}
 */
export const combobox_filter = {
  async setup(scope, args) {
    const count = Number(args.options);
    const combobox = /** @type {UiCombobox} */ (document.createElement('ui-combobox'));
    combobox.setAttribute('searchable', '');
    combobox.setAttribute('label', 'Person');
    combobox.setAttribute('not-found-label', 'Nothing');
    scope.container.append(combobox);
    combobox.options = makeRows(count).map((row) => ({ value: row.id, label: row.name }));
    await rendered(combobox);

    const control = combobox.querySelector('[data-ui-part="combobox-control"]');
    if (control instanceof HTMLElement) control.click();
    await rendered(combobox);

    const input = combobox.querySelector('[data-ui-part="combobox-input"]');
    if (!(input instanceof HTMLInputElement)) {
      throw new Error('The combobox rendered no search input.');
    }
    return { combobox, input, generation: 0 };
  },
  async run(state) {
    state.generation += 1;
    const term = `Person ${String(state.generation)}`;
    state.input.value = term;
    state.input.dispatchEvent(new Event('input', { bubbles: true }));
    await rendered(state.combobox);
    await waitFor(
      () => (state.combobox.textContent ?? '').includes(term),
      'the filtered options',
    );
    return true;
  },
  check(answer) {
    expect(answer, true, 'the filtered option list');
  },
};
