import { nothing } from 'lit';
import {
  loadPreference,
  removePreference,
  savePreference,
} from '@core/preferences/persistence.js';
import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { anchorPanel } from '../internal/anchored-panel.js';
import { directionSign } from '../internal/dom.js';
import { matchesRow, normalizeText, readPath } from './filter-descriptor.js';
import { standardText } from '../internal/text.js';
import { UiTableColumn } from './ui-table-column.js';

const PAGINATION_MODES = new Set(['client', 'server', 'infinite', 'none']);
const SORT_DIRECTIONS = new Set(['asc', 'desc', '']);
const STICKY_POSITIONS = new Set(['start', 'end', '']);
const TABLE_STATE_VERSION = 1;

/**
 * How long a burst of config changes is allowed to run before it reaches storage.
 * Short enough that a reload right after a drag keeps the drag, long enough that
 * held-down arrow keys are one write instead of thirty.
 */
const PERSIST_DEBOUNCE_MS = 250;

/**
 * A table filter *is* a filter descriptor: the vocabulary lives in
 * `filter-descriptor.js`, which both this element and `ui-dynamic-filter` import,
 * so neither one owns the meaning of "matches" and neither has to know the other
 * exists. The two aliases keep the names this element's own API already uses.
 *
 * @typedef {'asc' | 'desc' | ''} TableSortDirection
 * @typedef {import('./filter-descriptor.js').FilterMatch} TableFilterMatch
 * @typedef {import('./filter-descriptor.js').FilterDescriptor} TableFilter
 * @typedef {{
 *   page: number,
 *   pageSize: number,
 *   offset: number,
 *   mode: string,
 *   sort: { key: string, direction: TableSortDirection },
 *   filters: readonly TableFilter[],
 * }} TableQuery
 * @typedef {'start' | 'end' | ''} TableStickyPosition
 * @typedef {{
 *   revision: number,
 *   ordered: readonly UiTableColumn[],
 *   visible: readonly UiTableColumn[],
 *   configurable: readonly UiTableColumn[],
 *   stickyOffsets: Map<UiTableColumn, number>,
 *   headerStyles: Map<UiTableColumn, string>,
 *   cellStyles: Map<UiTableColumn, string>,
 * }} ColumnPresentation
 * @typedef {{
 *   page?: number,
 *   pageSize?: number,
 *   sort?: { key?: string, direction?: TableSortDirection },
 *   filters?: readonly TableFilter[],
 *   columns?: {
 *     order?: readonly string[],
 *     hidden?: readonly string[],
 *     widths?: Readonly<Record<string, number>>,
 *     sticky?: Readonly<Record<string, TableStickyPosition>>,
 *   },
 * }} PersistedTableState
 */

/**
 * Native table + pagination controller.
 *
 * Data stays consumer-owned. `client` filters, sorts and slices supplied rows.
 * `server` renders supplied page and emits query state. `infinite` renders
 * accumulated rows and emits `load-more`. Same column/filter declarations serve
 * every mode.
 *
 * Events:
 * - `query-change`: full query after page, page-size, sort or filter changes
 * - `page-change`, `sort-change`, `filter-change`: same full query, scoped signal
 * - `load-more`: full query with the next accumulated offset
 * - `row-activate`: `{ row, index }` when `interactive` is set
 * - `column-change`: current serializable column configuration
 * - `state-restore`: restored table state and query
 */
export class UiTable extends SignalElement {
  static properties = {
    rows: { attribute: false },
    totalRows: { type: Number, attribute: 'total-rows' },
    pagination: { type: String },
    page: { type: Number, reflect: true },
    pageSize: { type: Number, attribute: 'page-size' },
    pageSizes: { type: String, attribute: 'page-sizes' },
    sortKey: { type: String, attribute: 'sort-key', reflect: true },
    sortDirection: { type: String, attribute: 'sort-direction', reflect: true },
    filters: { attribute: false },
    filterPredicate: { attribute: false },
    rowKey: { attribute: false },
    loading: { type: Boolean, reflect: true },
    interactive: { type: Boolean, reflect: true },
    tableClass: { type: String, attribute: 'table-class' },
    caption: { type: String },
    emptyLabel: { type: String, attribute: 'empty-label' },
    stateId: { type: String, attribute: 'state-id' },
    tableName: { type: String, attribute: 'table-name' },
    persistFilters: { type: Boolean, attribute: 'persist-filters' },
    columnChooser: { type: Boolean, attribute: 'column-chooser' },
    columnsOpen: { type: Boolean, attribute: 'columns-open', reflect: true },
    reorderableColumns: { type: Boolean, attribute: 'reorderable-columns' },
    resizableColumns: { type: Boolean, attribute: 'resizable-columns' },
  };

  /** @type {readonly unknown[]} */
  rows = [];

  totalRows = 0;
  pagination = 'client';
  page = 1;
  pageSize = 10;
  pageSizes = '10,20,50';
  sortKey = '';
  sortDirection = '';

  /**
   * Filter descriptors. `filter-descriptor.js` defines what they mean —
   * `ANY_COLUMN` for "any declared column", the match modes, and the row
   * comparison — so a producer of filters and this consumer of them agree without
   * either importing the other.
   *
   * @type {readonly TableFilter[]}
   */
  filters = [];

  /** @type {((row: unknown, filters: readonly TableFilter[], index: number) => boolean) | undefined} */
  filterPredicate;

  /** @type {string | ((row: unknown, index: number) => unknown)} */
  rowKey = 'id';

  loading = false;
  interactive = false;
  tableClass = '';
  caption = '';

  /**
   * The one label a screen still owns: "No employees yet" names the data, where
   * "Previous page" names the interaction. Empty falls back to `ui.table.empty`.
   */
  emptyLabel = '';

  stateId = '';
  tableName = '';
  persistFilters = false;
  columnChooser = false;
  columnsOpen = false;
  reorderableColumns = false;
  resizableColumns = false;

  /** @type {UiTableColumn[]} */
  #columns = [];

  /** @type {string[]} */
  #columnOrder = [];

  /** @type {Set<string>} */
  #hiddenColumns = new Set();

  /** @type {Map<string, number>} */
  #columnWidths = new Map();

  /** @type {Map<string, TableStickyPosition>} */
  #stickyColumns = new Map();

  /** @type {Map<string, number>} */
  #measuredWidths = new Map();

  /** @type {PersistedTableState | undefined} */
  #pendingState;

  #loadedStateId = '';

  #restoredStatePending = false;

  /** @type {AbortController | undefined} */
  #resizeController;

  #draggedColumnKey = '';

  /** @type {Set<string>} */
  #knownColumnKeys = new Set();

  /** @type {{ page: number, pageSize: number, sortKey: string, sortDirection: string, filters: readonly TableFilter[] } | undefined} */
  #initialQueryState;

  /** @type {IntersectionObserver | undefined} */
  #intersectionObserver;

  /** The node `#intersectionObserver` is watching, so a re-render can tell it is the same one. */
  /** @type {Element | null} */
  #observedSentinel = null;

  #lastInfiniteRequest = '';

  #hasUpdated = false;

  #columnRevision = 0;

  /** @type {{
   * rows: readonly unknown[],
   * filters: readonly TableFilter[],
   * predicate: UiTable['filterPredicate'],
   * sortKey: string,
   * sortDirection: TableSortDirection,
   * columnRevision: number,
   * result: readonly unknown[],
   * } | undefined} */
  #processedCache;

  /**
   * Everything derived from the column declarations and the user's configuration
   * of them, computed once per change to either.
   *
   * The template asks for `visibleColumns` once per row and `cellStyle` once per
   * cell, so at 10,000 rows and four columns these getters ran 10,000 and 40,000
   * times for one render, each rebuilding a key map, an ordered array and, for a
   * sticky column, a walk over the visible columns to sum the widths in front of
   * it. None of that depends on the row: it depends on the columns, their order,
   * which are hidden, their widths and their sticky sides, and each of those has
   * one place it changes.
   *
   * So the projection is kept until `#presentationRevision` moves. The styles fill
   * in lazily because a table with no sticky column never needs the string, and
   * the offsets are computed one pass per side rather than one walk per column.
   *
   * @type {ColumnPresentation | undefined}
   */
  #presentation;

  /**
   * Bumped by every change the projection is derived from: the column set, their
   * order, which are hidden, their widths — authored, dragged and measured — and
   * their sticky sides. Separate from `#columnRevision` on purpose: that one keys
   * the processed-row cache, and dragging a resize handle must not re-filter and
   * re-sort ten thousand rows per pointer move.
   */
  #presentationRevision = 0;

  /** @type {(() => void) | undefined} */
  #releaseColumnsPanel;

  /** @type {HTMLElement | undefined} */
  #anchoredColumnsPanel;

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #persistTimer;

  connectedCallback() {
    this.#restoreState();
    this.addEventListener('ui-column-change', this.#onColumnChange, { signal: this.lifetime });
    super.connectedCallback();
    document.addEventListener('pointerdown', this.#onDocumentPointerDown, {
      signal: this.lifetime,
    });
    document.addEventListener('keydown', this.#onDocumentKeyDown, { signal: this.lifetime });
  }

  onDestroy() {
    this.#resizeController?.abort();
    this.#resizeController = undefined;
    this.#intersectionObserver?.disconnect();
    this.#intersectionObserver = undefined;
    this.#observedSentinel = null;
    this.#releaseColumnsPanel?.();
    this.#releaseColumnsPanel = undefined;
    // A debounced write must not be lost because the user navigated away half a
    // second after dragging a column: flush it, do not cancel it.
    this.#flushPersist();
  }

  get columns() {
    return this.#columns;
  }

  get persistenceId() {
    return this.stateId.trim() || this.tableName.trim();
  }

  /** Declared columns in the user's order, then any the order does not name. */
  get orderedColumns() {
    return this.#columnPresentation().ordered;
  }

  /** The columns a row actually renders a cell for. */
  get visibleColumns() {
    return this.#columnPresentation().visible;
  }

  /** The columns the chooser offers, hideable or merely movable. */
  get configurableColumns() {
    return this.#columnPresentation().configurable;
  }

  get showColumnChooser() {
    return this.columnChooser && this.configurableColumns.length > 0;
  }

  get normalizedMode() {
    return PAGINATION_MODES.has(this.pagination) ? this.pagination : 'client';
  }

  get normalizedSortDirection() {
    return SORT_DIRECTIONS.has(this.sortDirection)
      ? /** @type {TableSortDirection} */ (this.sortDirection)
      : '';
  }

  get normalizedFilters() {
    return Array.isArray(this.filters) ? /** @type {readonly TableFilter[]} */ (this.filters) : [];
  }

  get processesLocally() {
    return this.normalizedMode === 'client' || this.normalizedMode === 'none';
  }

  /** @returns {TableQuery} */
  get query() {
    return {
      page: this.page,
      pageSize: this.validPageSize,
      offset: (this.page - 1) * this.validPageSize,
      mode: this.normalizedMode,
      sort: { key: this.sortKey, direction: this.normalizedSortDirection },
      filters: this.normalizedFilters,
    };
  }

  get processedRows() {
    if (!this.processesLocally) return this.rows;

    const direction = this.normalizedSortDirection;
    const filters = this.normalizedFilters;
    const cached = this.#processedCache;
    if (
      cached !== undefined &&
      cached.rows === this.rows &&
      cached.filters === filters &&
      cached.predicate === this.filterPredicate &&
      cached.sortKey === this.sortKey &&
      cached.sortDirection === direction &&
      cached.columnRevision === this.#columnRevision
    ) {
      return cached.result;
    }

    let result = this.rows;
    if (filters.length > 0) {
      result = result.filter((row, index) => this.#matchesFilters(row, index, filters));
    }
    if (this.sortKey !== '' && direction !== '') {
      result = result
        .map((row, index) => ({ row, index, value: this.#sortValue(row, index) }))
        .sort((left, right) => {
          const compared = compareValues(left.value, right.value, direction);
          return compared === 0 ? left.index - right.index : compared;
        })
        .map((entry) => entry.row);
    }

    this.#processedCache = {
      rows: this.rows,
      filters,
      predicate: this.filterPredicate,
      sortKey: this.sortKey,
      sortDirection: direction,
      columnRevision: this.#columnRevision,
      result,
    };
    return result;
  }

  get collectionSize() {
    return this.processesLocally ? this.processedRows.length : Math.max(0, this.totalRows);
  }

  get pageCount() {
    return Math.max(1, Math.ceil(this.collectionSize / this.validPageSize));
  }

  get validPageSize() {
    return Math.max(1, Math.trunc(this.pageSize) || 1);
  }

  get visibleRows() {
    if (this.normalizedMode === 'none') return this.processedRows;
    if (this.normalizedMode !== 'client') return this.rows;
    const start = (this.page - 1) * this.validPageSize;
    return this.processedRows.slice(start, start + this.validPageSize);
  }

  get hasRows() {
    return this.visibleRows.length > 0;
  }

  get showLoading() {
    return this.loading && !this.hasRows;
  }

  get showEmpty() {
    return !this.loading && !this.hasRows;
  }

  get showPaginator() {
    return (
      (this.normalizedMode === 'client' || this.normalizedMode === 'server') &&
      this.collectionSize > 0
    );
  }

  get showInfiniteControl() {
    return this.normalizedMode === 'infinite' && this.rows.length < this.collectionSize;
  }

  get pageOptions() {
    const parsed = this.pageSizes
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value > 0);
    return [...new Set([...parsed, this.validPageSize])]
      .sort((left, right) => left - right)
      .map((value) => ({ value, label: String(value) }));
  }

  get selectedPageSize() {
    return String(this.validPageSize);
  }

  get pageNumbers() {
    const count = this.pageCount;
    const start = Math.max(1, Math.min(this.page - 2, count - 4));
    const end = Math.min(count, start + 4);
    return Array.from({ length: end - start + 1 }, (_unused, index) => start + index);
  }

  get statusText() {
    const first = this.collectionSize === 0 ? 0 : (this.page - 1) * this.validPageSize + 1;
    const last = Math.min(this.page * this.validPageSize, this.collectionSize);
    return `${String(first)}–${String(last)} / ${String(this.collectionSize)}`;
  }

  /**
   * `page` on the button for the page being shown, and the attribute absent
   * everywhere else. `aria-current="false"` would also be correct ARIA and is
   * avoided on purpose: it makes the styling a matter of matching a value rather
   * than of the attribute existing, which is one more thing to get wrong.
   *
   * @param {number} number
   */
  pageCurrent(number) {
    return number === this.page ? 'page' : nothing;
  }

  get previousDisabled() {
    return this.loading || this.page <= 1;
  }

  get nextDisabled() {
    return this.loading || this.page >= this.pageCount;
  }

  get columnSpan() {
    return Math.max(1, this.visibleColumns.length);
  }

  get rowTabIndex() {
    return this.interactive ? '0' : nothing;
  }

  /** @param {Map<PropertyKey, unknown>} changed */
  updated(changed) {
    super.updated(changed);
    this.#collectColumns();
    if (this.persistenceId !== this.#loadedStateId) this.#restoreState();
    const filtersChanged = this.#hasUpdated && changed.has('filters');
    if (filtersChanged) {
      this.page = 1;
      this.#lastInfiniteRequest = '';
    }
    this.#clampPage();
    this.#watchInfiniteSentinel();
    this.toggleAttribute('data-mode-client', this.normalizedMode === 'client');
    this.toggleAttribute('data-mode-server', this.normalizedMode === 'server');
    this.toggleAttribute('data-mode-infinite', this.normalizedMode === 'infinite');
    if (changed.has('loading') && !this.loading) this.#lastInfiniteRequest = '';
    if (filtersChanged) {
      this.#dispatchQueryEvent('filter-change');
      this.#dispatchQueryEvent('query-change');
    }
    this.#measureVisibleColumns();
    this.#anchorColumnsPanel();
    if (this.#restoredStatePending) {
      this.#restoredStatePending = false;
      this.dispatchEvent(
        new CustomEvent('state-restore', {
          bubbles: true,
          detail: { state: this.state, query: this.query },
        }),
      );
    } else if (this.#hasUpdated && this.#queryStateChanged(changed)) {
      this.#schedulePersist();
    }
    this.#hasUpdated = true;
  }

  /**
   * The column chooser floats above the page rather than inside it.
   *
   * A card wrapping a table almost always clips its own corners, and a table two
   * rows tall is shorter than a list of twelve columns. Both of those cut the
   * panel off in exactly the place a user cannot scroll to. `anchorPanel` moves it
   * to the top layer, where the card's overflow does not apply, and caps it at the
   * room actually available so a long list scrolls instead of vanishing.
   */
  #anchorColumnsPanel() {
    const panel = /** @type {HTMLElement | null} */ (
      this.querySelector('[data-ui-part="table-columns-panel"]')
    );
    if (!this.columnsOpen || panel === null) {
      this.#releaseColumnsPanel?.();
      this.#releaseColumnsPanel = undefined;
      this.#anchoredColumnsPanel = undefined;
      return;
    }
    if (panel === this.#anchoredColumnsPanel) return;
    const trigger = /** @type {HTMLElement | null} */ (
      this.querySelector('[data-ui-part="table-columns-trigger"]')
    );
    if (trigger === null) return;
    this.#releaseColumnsPanel?.();
    this.#releaseColumnsPanel = anchorPanel(trigger, panel, { align: 'end', maxHeight: 420 });
    this.#anchoredColumnsPanel = panel;
  }

  #onColumnChange = () => {
    this.#columnRevision += 1;
    this.#processedCache = undefined;
    this.#invalidateColumnPresentation();
    this.#collectColumns();
    this.#reconcileColumnState();
    this.requestUpdate();
  };

  #collectColumns() {
    const found = /** @type {UiTableColumn[]} */ (
      [...this.querySelectorAll('x-content > ui-table-column')]
    );
    if (
      found.length === this.#columns.length &&
      found.every((column, index) => column === this.#columns[index])
    ) {
      return;
    }
    this.#columns = found;
    this.#invalidateColumnPresentation();
    this.#reconcileColumnState();
    this.#columnRevision += 1;
    this.#processedCache = undefined;
    this.requestUpdate();
  }

  #clampPage() {
    if (this.collectionSize === 0) {
      const next = Math.max(1, Math.trunc(this.page) || 1);
      if (next !== this.page) this.page = next;
      return;
    }
    const next = Math.max(1, Math.min(Math.trunc(this.page) || 1, this.pageCount));
    if (next !== this.page) this.page = next;
  }

  /** @param {UiTableColumn} column @param {unknown} row @param {number} index */
  renderCell(column, row, index) {
    const value = readPath(row, column.key);
    return column.renderer?.(row, index, value) ?? value ?? nothing;
  }

  /** Serializable configuration currently owned by this table. */
  get state() {
    /** @type {Record<string, number>} */
    const widths = {};
    /** @type {Record<string, TableStickyPosition>} */
    const sticky = {};
    for (const column of this.orderedColumns) {
      const width = this.#columnWidths.get(column.key) ?? column.width;
      if (width !== undefined) widths[column.key] = width;
      const position = this.columnSticky(column);
      if (position !== '') sticky[column.key] = position;
    }

    /** @type {PersistedTableState} */
    const state = {
      page: Math.max(1, Math.trunc(this.page) || 1),
      pageSize: this.validPageSize,
      sort: { key: this.sortKey, direction: this.normalizedSortDirection },
      columns: {
        order: this.orderedColumns.map((column) => column.key),
        hidden: [...this.#hiddenColumns],
        widths,
        sticky,
      },
    };
    if (this.persistFilters) state.filters = serializableFilters(this.normalizedFilters);
    return state;
  }

  /** Persist current config immediately. No-op without `state-id`/`table-name`. */
  saveState() {
    clearTimeout(this.#persistTimer);
    this.#persistTimer = undefined;
    const id = this.persistenceId;
    if (id === '') return false;
    const saved = savePreference('ui-table', id, this.state, {
      schemaVersion: TABLE_STATE_VERSION,
    });
    if (saved) {
      this.dispatchEvent(new CustomEvent('state-change', { bubbles: true, detail: this.state }));
    }
    return saved;
  }

  /**
   * Persist soon, not now.
   *
   * Every internal trigger comes through here, because the interesting ones arrive
   * in bursts: holding ArrowRight on a resize handle is one write to localStorage
   * and one `state-change` event per keypress, and `JSON.stringify` of the whole
   * column model each time. `saveState()` stays the immediate path, for a consumer
   * that means now — and `onDestroy` flushes, so nothing is lost by leaving.
   */
  #schedulePersist() {
    if (this.persistenceId === '') return;
    clearTimeout(this.#persistTimer);
    this.#persistTimer = setTimeout(() => {
      this.#persistTimer = undefined;
      this.saveState();
    }, PERSIST_DEBOUNCE_MS);
  }

  #flushPersist() {
    if (this.#persistTimer === undefined) return;
    this.saveState();
  }

  /** Remove persisted config, restore authored defaults, then persist those defaults. */
  resetState() {
    const id = this.persistenceId;
    if (id !== '') removePreference('ui-table', id);
    const initial = this.#initialQueryState;
    if (initial !== undefined) {
      this.page = initial.page;
      this.pageSize = initial.pageSize;
      this.sortKey = initial.sortKey;
      this.sortDirection = initial.sortDirection;
      if (this.persistFilters) this.filters = initial.filters;
    }
    this.resetColumns();
    this.#dispatchQueryEvent('query-change');
  }

  /** @param {UiTableColumn} column */
  isColumnHidden(column) {
    return this.#hiddenColumns.has(column.key);
  }

  /** @param {UiTableColumn} column */
  canHideColumn(column) {
    return column.hideable && (!this.isColumnHidden(column) || this.visibleColumns.length > 1);
  }

  /** @param {UiTableColumn} column */
  toggleColumn(column) {
    if (!this.canHideColumn(column)) return;
    if (this.#hiddenColumns.has(column.key)) this.#hiddenColumns.delete(column.key);
    else this.#hiddenColumns.add(column.key);
    this.#columnConfigurationChanged('visibility');
  }

  resetColumns() {
    this.#columnOrder = this.columns.map((column) => column.key);
    this.#hiddenColumns = new Set(
      this.columns.filter((column) => column.hideable && column.hiddenByDefault).map((column) => column.key),
    );
    this.#columnWidths.clear();
    this.#stickyColumns.clear();
    this.#columnConfigurationChanged('reset');
  }

  /** @param {UiTableColumn} column */
  columnReorderable(column) {
    return this.reorderableColumns && !column.locked;
  }

  /** @param {UiTableColumn} column */
  columnResizable(column) {
    return (this.resizableColumns || column.resizable) && !column.locked;
  }

  /** @param {UiTableColumn} column */
  columnWidth(column) {
    return this.#columnWidths.get(column.key) ?? column.width;
  }

  /** @param {UiTableColumn} column @returns {TableStickyPosition} */
  columnSticky(column) {
    return this.#stickyColumns.get(column.key) ?? column.sticky;
  }

  /** @param {UiTableColumn} column */
  headerStyle(column) {
    return this.#columnStyle(column, true);
  }

  /** @param {UiTableColumn} column */
  cellStyle(column) {
    return this.#columnStyle(column, false);
  }

  /**
   * Standard interaction text: everything this element says about itself, from
   * `ui.table.*`. See `text.js` for why these are not properties any more.
   *
   * @param {string} name
   * @returns {string}
   */
  text(name) {
    return standardText('table', name);
  }

  /** The screen's own empty state, or the standard one. */
  get emptyText() {
    return this.emptyLabel === '' ? this.text('empty') : this.emptyLabel;
  }

  /** @param {UiTableColumn} column */
  stickyActionText(column) {
    const position = this.columnSticky(column);
    const name =
      position === '' ? 'stickyStart' : position === 'start' ? 'stickyEnd' : 'unstick';
    return this.columnActionText(name, column);
  }

  /**
   * An accessible name that says which column the control acts on, because six
   * identical "Resize column" buttons in a header row name nothing.
   *
   * @param {string} name Standard-text name of the action.
   * @param {UiTableColumn} column
   */
  columnActionText(name, column) {
    const action = this.text(name);
    return action === '' ? column.label : `${action} ${column.label}`;
  }

  /** @param {UiTableColumn} column */
  cycleSticky(column) {
    if (column.locked) return;
    const current = this.columnSticky(column);
    const next = current === '' ? 'start' : current === 'start' ? 'end' : '';
    this.#stickyColumns.set(column.key, next);
    this.#columnConfigurationChanged('sticky');
  }

  /** @param {UiTableColumn} column @param {number} delta */
  moveColumnBy(column, delta) {
    if (!this.columnReorderable(column)) return;
    const from = this.#columnOrder.indexOf(column.key);
    this.moveColumn(column.key, from + delta);
  }

  /** @param {string} key @param {number} targetIndex */
  moveColumn(key, targetIndex) {
    const from = this.#columnOrder.indexOf(key);
    if (from < 0) return false;
    const column = this.columns.find((candidate) => candidate.key === key);
    if (column === undefined || !this.columnReorderable(column)) return false;
    const next = [...this.#columnOrder];
    next.splice(from, 1);
    const target = Math.max(0, Math.min(Math.trunc(targetIndex), next.length));
    next.splice(target, 0, key);
    if (next.every((candidate, index) => candidate === this.#columnOrder[index])) return false;
    this.#columnOrder = next;
    this.#columnConfigurationChanged('order');
    return true;
  }

  /** @param {UiTableColumn} column @param {DragEvent} event */
  startColumnDrag(column, event) {
    if (!this.columnReorderable(column)) return;
    this.#draggedColumnKey = column.key;
    if (event.dataTransfer !== null) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', column.key);
    }
  }

  /** @param {UiTableColumn} column @param {DragEvent} event */
  allowColumnDrop(column, event) {
    if (this.#draggedColumnKey === '' || this.#draggedColumnKey === column.key) return;
    event.preventDefault();
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move';
  }

  /** @param {UiTableColumn} column @param {DragEvent} event */
  dropColumn(column, event) {
    event.preventDefault();
    const key = this.#draggedColumnKey || event.dataTransfer?.getData('text/plain') || '';
    this.#draggedColumnKey = '';
    const from = this.#columnOrder.indexOf(key);
    const target = this.#columnOrder.indexOf(column.key);
    if (from < 0 || target < 0 || key === column.key) return;
    this.moveColumn(key, target > from ? target - 1 : target);
  }

  /** @param {UiTableColumn} column @param {KeyboardEvent} event */
  reorderFromKeyboard(column, event) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    this.moveColumnBy(column, (event.key === 'ArrowLeft' ? -1 : 1) * directionSign(this));
  }

  /** @param {UiTableColumn} column @param {number} width */
  setColumnWidth(column, width) {
    if (!this.columnResizable(column)) return;
    const next = Math.round(Math.max(column.minWidth, Math.min(width, column.maxWidth)));
    if (next === this.columnWidth(column)) return;
    this.#columnWidths.set(column.key, next);
    // A width is a sticky offset for every column behind it, so the drag
    // invalidates the projection on the way past rather than at pointer-up.
    this.#invalidateColumnPresentation();
    this.requestUpdate();
  }

  /** @param {UiTableColumn} column @param {KeyboardEvent} event */
  resizeFromKeyboard(column, event) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const delta = (event.key === 'ArrowLeft' ? -10 : 10) * directionSign(this);
    this.setColumnWidth(column, (this.#effectiveColumnWidth(column) || column.minWidth) + delta);
    this.#columnConfigurationChanged('width');
  }

  /** @param {UiTableColumn} column @param {PointerEvent} event */
  beginResize(column, event) {
    if (!this.columnResizable(column) || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.#resizeController?.abort();
    this.#resizeController = new AbortController();
    const signal = this.#resizeController.signal;
    const startX = event.clientX;
    const startWidth = this.#effectiveColumnWidth(column) || column.minWidth;
    const direction = directionSign(this);
    window.addEventListener(
      'pointermove',
      (moveEvent) => this.setColumnWidth(column, startWidth + (moveEvent.clientX - startX) * direction),
      { signal },
    );
    window.addEventListener(
      'pointerup',
      () => {
        this.#resizeController?.abort();
        this.#resizeController = undefined;
        this.#columnConfigurationChanged('width');
      },
      { signal, once: true },
    );
  }

  /** @param {UiTableColumn} column */
  moveBeforeDisabled(column) {
    return !this.columnReorderable(column) || this.#columnOrder.indexOf(column.key) <= 0;
  }

  /** @param {UiTableColumn} column */
  moveAfterDisabled(column) {
    return (
      !this.columnReorderable(column) ||
      this.#columnOrder.indexOf(column.key) >= this.#columnOrder.length - 1
    );
  }

  /** @param {UiTableColumn} column */
  sortAria(column) {
    if (!column.sortable) return nothing;
    if (column.sortKey !== this.sortKey || this.normalizedSortDirection === '') return 'none';
    return this.normalizedSortDirection === 'asc' ? 'ascending' : 'descending';
  }

  /** @param {UiTableColumn} column */
  sortIcon(column) {
    if (column.sortKey !== this.sortKey || this.normalizedSortDirection === '') return '↕';
    return this.normalizedSortDirection === 'asc' ? '↑' : '↓';
  }

  /** @param {UiTableColumn} column */
  sortActionText(column) {
    const direction = this.#nextSortDirection(column);
    const name =
      direction === 'asc'
        ? 'sortAscending'
        : direction === 'desc'
          ? 'sortDescending'
          : 'clearSort';
    return this.columnActionText(name, column);
  }

  /** @param {UiTableColumn} column */
  toggleSort(column) {
    if (this.loading || !column.sortable) return;
    const direction = this.#nextSortDirection(column);
    this.sortKey = direction === '' ? '' : column.sortKey;
    this.sortDirection = direction;
    this.page = 1;
    this.#lastInfiniteRequest = '';
    this.#dispatchQueryEvent('sort-change');
    this.#dispatchQueryEvent('query-change');
  }

  /** @param {UiTableColumn} column @returns {TableSortDirection} */
  #nextSortDirection(column) {
    if (column.sortKey !== this.sortKey || this.normalizedSortDirection === '') {
      return /** @type {TableSortDirection} */ (column.sortStart);
    }
    if (this.normalizedSortDirection === column.sortStart) {
      return column.sortStart === 'asc' ? 'desc' : 'asc';
    }
    return '';
  }

  /** @param {unknown} row @param {number} index */
  keyFor(row, index) {
    if (typeof this.rowKey === 'function') return this.rowKey(row, index);
    const key = readPath(row, this.rowKey);
    return key ?? `${String(this.page)}:${String(index)}`;
  }

  /** @param {number} next */
  goTo(next) {
    if (this.loading) return;
    const page = Math.max(1, Math.min(Math.trunc(next) || 1, this.pageCount));
    if (page === this.page) return;
    this.page = page;
    this.#emitPageChange();
  }

  previous() {
    this.goTo(this.page - 1);
  }

  next() {
    this.goTo(this.page + 1);
  }

  /** @param {Event} event */
  changePageSize(event) {
    if (!(event.target instanceof HTMLSelectElement)) return;
    const size = Number(event.target.value);
    if (!Number.isInteger(size) || size <= 0 || size === this.validPageSize) return;
    this.pageSize = size;
    this.page = 1;
    this.#emitPageChange();
  }

  #emitPageChange() {
    this.#dispatchQueryEvent('page-change');
    this.#dispatchQueryEvent('query-change');
  }

  /** @param {'page-change' | 'sort-change' | 'filter-change' | 'query-change'} name */
  #dispatchQueryEvent(name) {
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, detail: this.query }));
  }

  /** @param {unknown} row @param {number} index @param {Event} event */
  activate(row, index, event) {
    if (!this.interactive || isInteractiveTarget(event.target)) return;
    this.dispatchEvent(
      new CustomEvent('row-activate', {
        bubbles: true,
        detail: { row, index: (this.page - 1) * this.validPageSize + index },
      }),
    );
  }

  /** @param {unknown} row @param {number} index @param {KeyboardEvent} event */
  activateFromKeyboard(row, index, event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    this.activate(row, index, event);
  }

  requestMore() {
    if (!this.showInfiniteControl || this.loading) return;
    const offset = this.rows.length;
    const key = `${String(offset)}:${String(this.validPageSize)}`;
    if (key === this.#lastInfiniteRequest) return;
    this.#lastInfiniteRequest = key;
    this.dispatchEvent(
      new CustomEvent('load-more', {
        bubbles: true,
        detail: {
          ...this.query,
          page: Math.floor(offset / this.validPageSize) + 1,
          offset,
        },
      }),
    );
  }

  /**
   * Watch the sentinel that asks for the next page when it scrolls into view.
   *
   * Called from `updated`, so it runs on every render — including the renders the
   * arriving rows themselves cause. Rebuilding the observer each time meant
   * disconnecting and reconstructing it while the user was still scrolling toward
   * it, and a fresh observer reports its first intersection asynchronously, so the
   * one thing this exists to notice was the thing most likely to be missed. The
   * sentinel element survives re-renders, so the observer can too: it is rebuilt
   * only when the node it watches actually changes.
   */
  #watchInfiniteSentinel() {
    const sentinel =
      this.showInfiniteControl && typeof IntersectionObserver !== 'undefined'
        ? this.querySelector('[data-ui-part="table-infinite"]')
        : null;
    if (sentinel === this.#observedSentinel) return;

    this.#intersectionObserver?.disconnect();
    this.#intersectionObserver = undefined;
    this.#observedSentinel = sentinel;
    if (sentinel === null) return;

    this.#intersectionObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) this.requestMore();
      },
      { rootMargin: '160px 0px' },
    );
    this.#intersectionObserver.observe(sentinel);
  }

  #restoreState() {
    const id = this.persistenceId;
    this.#loadedStateId = id;
    this.#initialQueryState ??= {
      page: this.page,
      pageSize: this.pageSize,
      sortKey: this.sortKey,
      sortDirection: this.sortDirection,
      filters: this.normalizedFilters,
    };
    if (id === '') return;
    const restored = normalizePersistedTableState(
      loadPreference('ui-table', id, { schemaVersion: TABLE_STATE_VERSION }),
    );
    if (restored === undefined) return;

    if (restored.page !== undefined) this.page = restored.page;
    if (restored.pageSize !== undefined) this.pageSize = restored.pageSize;
    if (restored.sort !== undefined) {
      this.sortKey = restored.sort.key ?? '';
      this.sortDirection = restored.sort.direction ?? '';
    }
    if (this.persistFilters && restored.filters !== undefined) this.filters = restored.filters;
    this.#pendingState = restored;
    this.#restoredStatePending = true;
    this.#reconcileColumnState();
    this.requestUpdate();
  }

  #reconcileColumnState() {
    if (
      this.columns.length === 0 ||
      this.columns.some((column) => typeof column.key !== 'string' || column.key === '')
    ) {
      return;
    }
    const keys = this.columns.map((column) => column.key).filter((key) => key !== '');
    const newColumns = this.columns.filter((column) => !this.#knownColumnKeys.has(column.key));
    for (const column of newColumns) {
      if (column.hideable && column.hiddenByDefault) this.#hiddenColumns.add(column.key);
    }
    this.#knownColumnKeys = new Set(keys);

    const persisted = this.#pendingState?.columns;
    const requestedOrder = persisted?.order ?? this.#columnOrder;
    this.#columnOrder = [
      ...requestedOrder.filter((key) => keys.includes(key)),
      ...keys.filter((key) => !requestedOrder.includes(key)),
    ];

    if (persisted?.hidden !== undefined) {
      const hideable = new Set(this.columns.filter((column) => column.hideable).map((column) => column.key));
      this.#hiddenColumns = new Set(persisted.hidden.filter((key) => hideable.has(key)));
    } else {
      this.#hiddenColumns = new Set([...this.#hiddenColumns].filter((key) => keys.includes(key)));
    }
    const firstKey = keys[0];
    if (this.#hiddenColumns.size === keys.length && firstKey !== undefined) {
      this.#hiddenColumns.delete(firstKey);
    }

    if (persisted?.widths !== undefined) {
      this.#columnWidths.clear();
      for (const column of this.columns) {
        const width = persisted.widths[column.key];
        if (typeof width === 'number' && Number.isFinite(width) && width > 0) {
          this.#columnWidths.set(
            column.key,
            Math.round(Math.max(column.minWidth, Math.min(width, column.maxWidth))),
          );
        }
      }
    }
    if (persisted?.sticky !== undefined) {
      this.#stickyColumns.clear();
      for (const column of this.columns) {
        const position = persisted.sticky[column.key];
        if (!column.locked && STICKY_POSITIONS.has(position ?? '')) {
          this.#stickyColumns.set(column.key, position ?? '');
        }
      }
    }
    this.#pendingState = undefined;
    this.#invalidateColumnPresentation();
  }

  /** @param {Map<PropertyKey, unknown>} changed */
  #queryStateChanged(changed) {
    return (
      changed.has('page') ||
      changed.has('pageSize') ||
      changed.has('sortKey') ||
      changed.has('sortDirection') ||
      (this.persistFilters && changed.has('filters'))
    );
  }

  /** @param {string} reason */
  #columnConfigurationChanged(reason) {
    this.#columnRevision += 1;
    this.#processedCache = undefined;
    this.#invalidateColumnPresentation();
    this.requestUpdate();
    const columns = this.state.columns;
    this.dispatchEvent(new CustomEvent('column-change', { bubbles: true, detail: { reason, columns } }));
    this.#schedulePersist();
  }

  /**
   * The derived column projection, rebuilt only when `#presentationRevision` moved.
   *
   * `#reconcileColumnState` runs first and may itself invalidate, which is why the
   * revision is read after it: the lazy reconcile is how a table whose columns
   * arrived before its persisted state gets an order at all, and it has to be able
   * to make the projection it is about to be used for stale.
   */
  #columnPresentation() {
    if (this.columns.length > 0 && (this.#columnOrder.length === 0 || this.#pendingState !== undefined)) {
      this.#reconcileColumnState();
    }
    const cached = this.#presentation;
    if (cached !== undefined && cached.revision === this.#presentationRevision) return cached;

    const byKey = new Map(this.columns.map((column) => [column.key, column]));
    const named = new Set(this.#columnOrder);
    /** @type {UiTableColumn[]} */
    const ordered = [];
    for (const key of this.#columnOrder) {
      const column = byKey.get(key);
      if (column !== undefined) ordered.push(column);
    }
    for (const column of this.columns) {
      if (!named.has(column.key)) ordered.push(column);
    }
    const visible = ordered.filter((column) => !this.#hiddenColumns.has(column.key));

    /** @type {ColumnPresentation} */
    const presentation = {
      revision: this.#presentationRevision,
      ordered: Object.freeze(ordered),
      visible: Object.freeze(visible),
      configurable: Object.freeze(ordered.filter((column) => column.hideable || !column.locked)),
      stickyOffsets: stickyOffsets(
        visible,
        (column) => this.columnSticky(column),
        (column) => this.#effectiveColumnWidth(column),
      ),
      headerStyles: new Map(),
      cellStyles: new Map(),
    };
    this.#presentation = presentation;
    return presentation;
  }

  /**
   * Mark the projection stale. Cheap on purpose: it is called from every mutation
   * that feeds the projection, including one per pointer move during a resize
   * drag, and the rebuild happens once on the next read rather than once per call.
   */
  #invalidateColumnPresentation() {
    this.#presentationRevision += 1;
  }

  /** @param {UiTableColumn} column @param {boolean} header */
  #columnStyle(column, header) {
    const presentation = this.#columnPresentation();
    const cache = header ? presentation.headerStyles : presentation.cellStyles;
    const cached = cache.get(column);
    if (cached !== undefined) return cached;

    const declarations = [];
    const width = this.columnWidth(column);
    if (width !== undefined) {
      declarations.push(`width:${String(width)}px`, `min-width:${String(width)}px`, `max-width:${String(width)}px`);
    }
    const position = this.columnSticky(column);
    if (position !== '') {
      declarations.push(
        'position:sticky',
        `${position === 'start' ? 'inset-inline-start' : 'inset-inline-end'}:${String(
          presentation.stickyOffsets.get(column) ?? 0,
        )}px`,
        `z-index:${header ? '3' : '2'}`,
        `background:${header ? 'var(--ui-color-canvas)' : 'var(--ui-color-surface)'}`,
      );
    }
    const style = declarations.join(';');
    cache.set(column, style);
    return style;
  }

  /** @param {UiTableColumn} column */
  #effectiveColumnWidth(column) {
    return this.columnWidth(column) ?? this.#measuredWidths.get(column.key) ?? 0;
  }

  #measureVisibleColumns() {
    let changed = false;
    for (const header of this.querySelectorAll('[data-ui-part="table-header"][data-column-key]')) {
      const key = header.getAttribute('data-column-key') ?? '';
      const width = Math.round(header.getBoundingClientRect().width);
      if (key !== '' && width > 0 && this.#measuredWidths.get(key) !== width) {
        this.#measuredWidths.set(key, width);
        changed = true;
      }
    }
    if (!changed) return;
    // A measured width feeds the sticky offsets of the columns behind it, so the
    // projection is stale whether or not this table has enough sticky columns for
    // the offsets to differ.
    this.#invalidateColumnPresentation();
    if (this.visibleColumns.filter((column) => this.columnSticky(column) !== '').length > 1) {
      this.requestUpdate();
    }
  }

  /** @param {PointerEvent} event */
  #onDocumentPointerDown = (event) => {
    if (!this.columnsOpen) return;
    const control = this.querySelector('[data-ui-part="table-columns-control"]');
    if (control !== null && event.composedPath().includes(control)) return;
    this.columnsOpen = false;
  };

  /** @param {KeyboardEvent} event */
  #onDocumentKeyDown = (event) => {
    if (event.key === 'Escape') this.columnsOpen = false;
  };

  /** @param {unknown} row @param {number} index @param {readonly TableFilter[]} filters */
  #matchesFilters(row, index, filters) {
    if (this.filterPredicate !== undefined) return this.filterPredicate(row, filters, index);
    return filters.every((filter) => matchesRow(row, index, filter, this.columns));
  }

  /** @param {unknown} row @param {number} index */
  #sortValue(row, index) {
    const column = this.columns.find((candidate) => candidate.sortKey === this.sortKey);
    const value = readPath(row, column?.key ?? this.sortKey);
    return column?.sortValue?.(row, index, value) ?? value;
  }
}

/** @param {unknown} value @returns {PersistedTableState | undefined} */
function normalizePersistedTableState(value) {
  if (value === null || typeof value !== 'object') return undefined;
  const source = /** @type {Record<string, unknown>} */ (value);
  /** @type {PersistedTableState} */
  const state = {};

  if (typeof source.page === 'number' && Number.isInteger(source.page) && source.page > 0) {
    state.page = source.page;
  }
  if (
    typeof source.pageSize === 'number' &&
    Number.isInteger(source.pageSize) &&
    source.pageSize > 0
  ) {
    state.pageSize = source.pageSize;
  }
  if (source.sort !== null && typeof source.sort === 'object') {
    const sort = /** @type {Record<string, unknown>} */ (source.sort);
    const key = typeof sort.key === 'string' ? sort.key : '';
    const rawDirection = typeof sort.direction === 'string' ? sort.direction : '';
    const direction = SORT_DIRECTIONS.has(rawDirection)
      ? /** @type {TableSortDirection} */ (rawDirection)
      : '';
    state.sort = { key, direction };
  }
  if (Array.isArray(source.filters)) {
    state.filters = /** @type {readonly TableFilter[]} */ (source.filters);
  }
  if (source.columns !== null && typeof source.columns === 'object') {
    const columns = /** @type {Record<string, unknown>} */ (source.columns);
    const order = Array.isArray(columns.order)
      ? columns.order.filter((key) => typeof key === 'string')
      : [];
    const hidden = Array.isArray(columns.hidden)
      ? columns.hidden.filter((key) => typeof key === 'string')
      : [];
    const widths = isRecord(columns.widths)
      ? /** @type {Readonly<Record<string, number>>} */ (columns.widths)
      : {};
    const sticky = isRecord(columns.sticky)
      ? /** @type {Readonly<Record<string, TableStickyPosition>>} */ (columns.sticky)
      : {};
    state.columns = { order, hidden, widths, sticky };
  }
  return state;
}

/**
 * Filters as JSON keeps `key`, `value` and `match`, and drops every `predicate`:
 * a function has no JSON form. So a descriptor whose comparison came from its rule
 * type restores intact, and one carrying a hand-written predicate restores as a
 * plain `match` — which is one more reason the rule types now imply their own
 * comparison rather than leaving screens to write one.
 *
 * @param {readonly TableFilter[]} filters
 * @returns {readonly TableFilter[]}
 */
function serializableFilters(filters) {
  try {
    const value = /** @type {unknown} */ (JSON.parse(JSON.stringify(filters)));
    return Array.isArray(value) ? /** @type {readonly TableFilter[]} */ (value) : [];
  } catch {
    return [];
  }
}

/**
 * How far each sticky column sits from its own edge: the summed width of the
 * sticky columns between it and that edge.
 *
 * One pass per side over the visible columns, rather than one walk per column
 * asking the same question — at twenty-four columns with twelve sticky that is two
 * passes instead of twelve walks, and each cell then reads a map.
 *
 * The `has` guard keeps the answer the per-column walk gave: it stopped at the
 * first column identical to the one it was asked about, so a column appearing
 * twice — which only a duplicate `key` produces — keeps its first offset.
 *
 * @param {readonly UiTableColumn[]} visible
 * @param {(column: UiTableColumn) => TableStickyPosition} positionOf
 * @param {(column: UiTableColumn) => number} widthOf
 * @returns {Map<UiTableColumn, number>}
 */
function stickyOffsets(visible, positionOf, widthOf) {
  /** @type {Map<UiTableColumn, number>} */
  const offsets = new Map();
  let fromStart = 0;
  for (const column of visible) {
    if (positionOf(column) !== 'start') continue;
    if (!offsets.has(column)) offsets.set(column, fromStart);
    fromStart += widthOf(column);
  }
  let fromEnd = 0;
  for (let index = visible.length - 1; index >= 0; index -= 1) {
    const column = visible[index];
    if (column === undefined || positionOf(column) !== 'end') continue;
    if (!offsets.has(column)) offsets.set(column, fromEnd);
    fromEnd += widthOf(column);
  }
  return offsets;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} left @param {unknown} right @param {TableSortDirection} direction */
function compareValues(left, right, direction) {
  const leftEmpty = left === null || left === undefined;
  const rightEmpty = right === null || right === undefined;
  if (leftEmpty || rightEmpty) {
    if (leftEmpty && rightEmpty) return 0;
    return leftEmpty ? 1 : -1;
  }

  let compared;
  if (typeof left === 'number' && typeof right === 'number') {
    compared = left - right;
  } else if (left instanceof Date && right instanceof Date) {
    compared = left.getTime() - right.getTime();
  } else {
    compared = normalizeText(left).localeCompare(normalizeText(right), undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  }
  return direction === 'desc' ? -compared : compared;
}

/** @param {EventTarget | null} target */
function isInteractiveTarget(target) {
  return (
    target instanceof Element &&
    target.closest('a, button, input, select, textarea, summary, [contenteditable], [role="button"]') !==
      null
  );
}

// `uses` rather than the side-effect import this had: a table reads its
// `<ui-table-column>` children, so that element existing is this component's
// dependency and now says so as a value.
await defineComponent({
  tag: 'ui-table',
  element: UiTable,
  module: import.meta.url,
  uses: [UiTableColumn],
});
