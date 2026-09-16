import { nothing } from 'lit';
import {
  loadPreference,
  removePreference,
  savePreference,
} from '@core/preferences/persistence.js';
import { schedule } from '@core/foundation/clock.js';
import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { panelBinding } from '../internal/open-panel.js';
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
 * Rows rendered above and below the viewport when the window is on.
 *
 * Four is what a wheel notch or a trackpad flick moves before the scroll event
 * that redraws the window arrives, so the user sees rows rather than the gap the
 * spacer leaves. Larger buys nothing, because the cost of the window is the rows
 * in it.
 */
const WINDOW_OVERSCAN = 4;

/** The row height assumed until a rendered row has been measured. */
const DEFAULT_ROW_HEIGHT = 44;

/** The scroller height used when `viewport-height` names none. */
const DEFAULT_VIEWPORT_HEIGHT = 480;

/**
 * A table filter is a filter descriptor. The vocabulary lives in
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
 * @typedef {{
 *   keys: readonly unknown[],
 *   rows: readonly unknown[],
 *   scope: 'loaded',
 * }} TableSelection
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
 * `virtualized` bounds what reaches the DOM to the rows a scrolling viewport can
 * show, with spacer rows holding the scroll extent. It changes what is rendered
 * and nothing else, so the page, the selection and the query still cover every
 * row the table was given. ADR-0107.
 *
 * Events:
 * - `query-change`: full query after page, page-size, sort or filter changes
 * - `page-change`, `sort-change`, `filter-change`: same full query, scoped signal
 * - `load-more`: full query with the next accumulated offset
 * - `row-activate`: `{ row, index }` when `interactive` is set
 * - `selection-change`: selected keys, the loaded rows behind them, and their scope
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
    selectable: { type: Boolean, reflect: true },
    selectedKeys: { attribute: false },
    rowSelectable: { attribute: false },
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
    virtualized: { type: Boolean, reflect: true },
    rowHeight: { type: Number, attribute: 'row-height' },
    viewportHeight: { type: Number, attribute: 'viewport-height' },
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
   * Filter descriptors. `filter-descriptor.js` defines what they mean, from
   * `ANY_COLUMN` for "any declared column" through the match modes to the row
   * comparison, so a producer of filters and this consumer of them agree without
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

  /**
   * Render the selection column.
   *
   * A selection is a set of row keys rather than a set of positions, so sorting,
   * paging and filtering leave it alone, and it covers the rows this table has
   * been given and no others. ADR-0105.
   */
  selectable = false;

  /**
   * The chosen keys, first choice first.
   *
   * Consumer-owned the way `rows` is, so assign a new array to change it from
   * outside. The caches keyed on it compare identity, so an array mutated in place
   * is the same array and nothing re-reads it.
   *
   * @type {readonly unknown[]}
   */
  selectedKeys = [];

  /**
   * Which rows may be chosen. A row this refuses renders a disabled checkbox and
   * is skipped by select-all and by a shift range, so a screen never has to undo a
   * choice the user should not have been offered.
   *
   * @type {((row: unknown, index: number) => boolean) | undefined}
   */
  rowSelectable;

  tableClass = '';
  caption = '';

  /**
   * The one label a screen still owns. "No employees yet" names the data, where
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

  /**
   * Render only the rows a scrolling viewport can show.
   *
   * Off by default, because it makes three promises about the screen that the
   * table cannot check. The rows are uniform in height, the table is its own
   * scroller, and the columns lay out fixed. ADR-0107.
   */
  virtualized = false;

  /**
   * The row height the window assumes before a row has been rendered to measure.
   *
   * A rendered row replaces it, so this only has to be close enough that the first
   * paint covers the viewport.
   */
  rowHeight = DEFAULT_ROW_HEIGHT;

  /**
   * The scroller's height in pixels while `virtualized` is set.
   *
   * Written as `max-height`, so a stylesheet that constrains the scroller wins and
   * the measured height is what the window is computed from either way.
   */
  viewportHeight = DEFAULT_VIEWPORT_HEIGHT;

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

  /** The scroller the window is computed against, or `null` before the first render. */
  /** @type {HTMLElement | null} */
  #scroller = null;

  /** @type {AbortController | undefined} */
  #scrollController;

  /** @type {ResizeObserver | undefined} */
  #viewportObserver;

  #scrollTop = 0;

  /** The scroller's content-box height, or 0 until it has been measured. */
  #measuredViewport = 0;

  /** A rendered row's height, or 0 until one has been measured. */
  #measuredRowHeight = 0;

  /**
   * The row a scroll is about to unmount from under the keyboard, and which part
   * of it had focus, so the same part of the nearest surviving row can take it.
   *
   * @type {{ index: number, part: string } | undefined}
   */
  #focusRecovery;

  /** @type {{
   * total: number,
   * scrollTop: number,
   * rowHeight: number,
   * viewport: number,
   * virtualized: boolean,
   * value: { start: number, end: number, above: number, below: number },
   * } | undefined} */
  #windowCache;

  /** @type {{
   * rows: readonly unknown[],
   * processed: readonly unknown[],
   * page: number,
   * pageSize: number,
   * mode: string,
   * value: readonly unknown[],
   * } | undefined} */
  #visibleCache;

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

  /** @type {{ keys: readonly unknown[], set: Set<unknown> } | undefined} */
  #selectionCache;

  /** @type {{
   * rows: readonly unknown[],
   * keys: readonly unknown[],
   * predicate: UiTable['rowSelectable'],
   * page: number,
   * pageSize: number,
   * mode: string,
   * value: { selectable: number, selected: number },
   * } | undefined} */
  #pageSelectionCache;

  /** The key a shift-click measures its range from, or `undefined`. @type {unknown} */
  #selectionAnchor;

  /**
   * Everything derived from the column declarations and the user's configuration
   * of them, computed once per change to either.
   *
   * The template asks for `visibleColumns` once per row and `cellStyle` once per
   * cell, so at 10,000 rows and four columns these getters ran 10,000 and 40,000
   * times for one render, each rebuilding a key map, an ordered array and, for a
   * sticky column, a walk over the visible columns to sum the widths in front of
   * it. None of that depends on the row. It depends on the columns, their order,
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
   * Bumped by every change the projection is derived from, which is the column
   * set, their order, which are hidden, their widths (authored, dragged and
   * measured) and their sticky sides.
   *
   * Separate from `#columnRevision` on purpose. That one keys the processed-row
   * cache, and dragging a resize handle must not re-filter and re-sort ten
   * thousand rows per pointer move.
   */
  #presentationRevision = 0;

  /**
   * The column chooser floats above the page rather than inside it.
   *
   * A card wrapping a table almost always clips its own corners, and a table two
   * rows tall is shorter than a list of twelve columns. Both of those cut the
   * panel off in exactly the place a user cannot scroll to. `panelBinding` moves
   * it to the top layer, where the card's overflow does not apply, and caps it at
   * the room actually available so a long list scrolls instead of vanishing.
   *
   * `within` is the toolbar strip rather than the table, so a pointer on a row is
   * outside the chooser and has to close it.
   */
  #columnsPanel = panelBinding({
    host: this,
    trigger: '[data-ui-part="table-columns-trigger"]',
    panel: '[data-ui-part="table-columns-panel"]',
    within: '[data-ui-part="table-columns-control"]',
    align: 'end',
    maxHeight: 420,
    lifetime: () => this.lifetime,
    onDismiss: () => {
      this.columnsOpen = false;
    },
  });

  /**
   * The call that cancels a scheduled write, while one is scheduled, and
   * `undefined` when none is. It comes from the injected clock rather than
   * `setTimeout`, so a suite reaches the far side of the debounce by draining the
   * clock instead of sleeping past this element's idea of "soon". ADR-0079.
   *
   * @type {(() => void) | undefined}
   */
  #cancelPersist;

  connectedCallback() {
    this.#restoreState();
    this.addEventListener('ui-column-change', this.#onColumnChange, { signal: this.lifetime });
    super.connectedCallback();
  }

  onDestroy() {
    this.#resizeController?.abort();
    this.#resizeController = undefined;
    this.#intersectionObserver?.disconnect();
    this.#intersectionObserver = undefined;
    this.#observedSentinel = null;
    this.#scrollController?.abort();
    this.#scrollController = undefined;
    this.#viewportObserver?.disconnect();
    this.#viewportObserver = undefined;
    this.#scroller = null;
    // A debounced write must not be lost because the user navigated away half a
    // second after dragging a column. Flush it, do not cancel it.
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

  /**
   * The rows this page holds, which is what selection, the status line and the
   * window are all measured against. `renderedRows` is what is in the DOM.
   *
   * Cached because a render asks for it a dozen times, once per selection
   * question and once per window arithmetic, and in `client` mode each of those
   * was a fresh slice.
   */
  get visibleRows() {
    const mode = this.normalizedMode;
    const processed = this.processedRows;
    const cached = this.#visibleCache;
    if (
      cached !== undefined &&
      cached.rows === this.rows &&
      cached.processed === processed &&
      cached.page === this.page &&
      cached.pageSize === this.validPageSize &&
      cached.mode === mode
    ) {
      return cached.value;
    }

    let value = this.rows;
    if (mode === 'none') value = processed;
    else if (mode === 'client') {
      const start = (this.page - 1) * this.validPageSize;
      value = processed.slice(start, start + this.validPageSize);
    }

    this.#visibleCache = {
      rows: this.rows,
      processed,
      page: this.page,
      pageSize: this.validPageSize,
      mode,
      value,
    };
    return value;
  }

  get validRowHeight() {
    return Math.max(1, Math.trunc(this.rowHeight) || DEFAULT_ROW_HEIGHT);
  }

  get validViewportHeight() {
    return Math.max(1, Math.trunc(this.viewportHeight) || DEFAULT_VIEWPORT_HEIGHT);
  }

  /**
   * The rows the DOM actually holds, and their offset from the page's first row.
   *
   * Computed rather than stored, so a page change, a sort, a filter and a resize
   * all move the window by moving what it is derived from. The overscan is applied
   * to the top as well as the bottom, and the start is pulled back when the last
   * screenful would otherwise render fewer rows than the viewport can show.
   */
  #window() {
    const total = this.visibleRows.length;
    const scrollTop = this.#scrollTop;
    const rowHeight = this.#measuredRowHeight > 0 ? this.#measuredRowHeight : this.validRowHeight;
    const viewport = this.#measuredViewport > 0 ? this.#measuredViewport : this.validViewportHeight;
    const { virtualized } = this;

    const cached = this.#windowCache;
    if (
      cached !== undefined &&
      cached.total === total &&
      cached.scrollTop === scrollTop &&
      cached.rowHeight === rowHeight &&
      cached.viewport === viewport &&
      cached.virtualized === virtualized
    ) {
      return cached.value;
    }

    let value = { start: 0, end: total, above: 0, below: 0 };
    if (virtualized && total > 0) {
      const count = Math.ceil(viewport / rowHeight) + WINDOW_OVERSCAN * 2;
      const first = Math.floor(scrollTop / rowHeight) - WINDOW_OVERSCAN;
      const start = Math.max(0, Math.min(first, total - count));
      const end = Math.min(total, start + count);
      value = { start, end, above: start * rowHeight, below: (total - end) * rowHeight };
    }

    this.#windowCache = { total, scrollTop, rowHeight, viewport, virtualized, value };
    return value;
  }

  /** The rows in the DOM: the whole page, or the part of it the window covers. */
  get renderedRows() {
    const rows = this.visibleRows;
    const { start, end } = this.#window();
    if (start === 0 && end === rows.length) return rows;
    return rows.slice(start, end);
  }

  /**
   * Where the row at `offset` in the rendered list sits on the page.
   *
   * The row template asks this rather than the loop index for a row's key, its
   * selected state and the record to activate, because a window renders row 8,412
   * in slot 3.
   *
   * @param {number} offset
   */
  rowIndexAt(offset) {
    return this.#window().start + offset;
  }

  /** The same index as an attribute, and absent when nothing is windowed. */
  /** @param {number} offset */
  rowIndexAttribute(offset) {
    return this.virtualized ? this.rowIndexAt(offset) : nothing;
  }

  /**
   * `aria-rowindex`, one-based and counting the header row, so assistive
   * technology reads "row 8,413 of 10,000" from a tbody holding sixty rows.
   *
   * @param {number} offset
   */
  rowAria(offset) {
    return this.virtualized ? this.rowIndexAt(offset) + 2 : nothing;
  }

  /** `aria-rowcount` for the whole page, including the header row. */
  get rowCountAria() {
    return this.virtualized ? this.visibleRows.length + 1 : nothing;
  }

  /** The header is row 1 of the count above, and unnumbered without one. */
  get headerRowAria() {
    return this.virtualized ? 1 : nothing;
  }

  get spaceAbove() {
    return this.#window().above;
  }

  get spaceBelow() {
    return this.#window().below;
  }

  /** @param {number} height */
  spacerStyle(height) {
    return `height:${String(Math.round(height))}px;border-top-width:0`;
  }

  /**
   * The scroller becomes the table's own viewport while the window is on, and is
   * focusable so a row unmounted from under the keyboard has somewhere to land.
   */
  get scrollStyle() {
    if (!this.virtualized) return '';
    return `overflow-y:auto;max-height:${String(this.validViewportHeight)}px`;
  }

  get scrollTabIndex() {
    return this.virtualized ? '-1' : nothing;
  }

  /** Fixed layout, because a column that resizes as rows scroll past is unusable. */
  get tableStyle() {
    return this.virtualized ? 'table-layout:fixed' : '';
  }

  /** The selection header carries no column, so it sticks on its own. */
  get selectionHeaderStyle() {
    if (!this.virtualized) return '';
    return 'position:sticky;top:0;z-index:3;background:var(--ui-color-canvas)';
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
   * avoided on purpose, because it makes the styling match a value rather than
   * the attribute existing, which is one more thing to get wrong.
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
    return Math.max(1, this.visibleColumns.length + (this.selectable ? 1 : 0));
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
    if (this.selectable && changed.has('rows')) this.#pruneSelection();
    if (changed.has('virtualized')) this.#invalidateColumnPresentation();
    this.#watchScroller();
    this.#rewindWindow(changed);
    this.#measureWindow();
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
    this.#columnsPanel.sync(this.columnsOpen);
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
    this.#restoreWindowFocus();
    this.#hasUpdated = true;
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

  /**
   * A cell's content, taken from the column's authored fragment, its renderer, or
   * the raw value.
   *
   * The fragment wins because it is the more specific declaration, and a column
   * carrying both said the markup twice. It also returns a renderable even when
   * the row has nothing at `key`, so `??` would never reach the renderer.
   *
   * @param {UiTableColumn} column @param {unknown} row @param {number} index
   */
  renderCell(column, row, index) {
    const value = readPath(row, column.key);
    if (column.cell !== undefined) return column.cell(row, index, value);
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
    this.#cancelPersist?.();
    this.#cancelPersist = undefined;
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
   * in bursts. Holding ArrowRight on a resize handle would otherwise be one write
   * to localStorage, one `state-change` event and one `JSON.stringify` of the
   * whole column model per keypress. `saveState()` stays the immediate path for a
   * consumer that means now, and `onDestroy` flushes, so nothing is lost by
   * leaving.
   */
  #schedulePersist() {
    if (this.persistenceId === '') return;
    this.#cancelPersist?.();
    this.#cancelPersist = schedule(() => {
      this.#cancelPersist = undefined;
      this.saveState();
    }, PERSIST_DEBOUNCE_MS);
  }

  #flushPersist() {
    if (this.#cancelPersist === undefined) return;
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
   * Standard interaction text, which is everything this element says about itself,
   * read from `ui.table.*`. `text.js` says why these are not properties.
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

  /* ── Selection ─────────────────────────────────────────────────────────── */

  /**
   * A row's identity, or `undefined` when it has none.
   *
   * Deliberately not `keyFor`, whose positional fallback exists to keep a `*for`
   * keyed when rows carry no id. A position is not an identity, because `2:3`
   * names a different record after a sort, so a selection built on it would follow
   * the slot rather than the row. A row the caller cannot name cannot be chosen.
   *
   * @param {unknown} row @param {number} index
   */
  #identity(row, index) {
    const key =
      typeof this.rowKey === 'function' ? this.rowKey(row, index) : readPath(row, this.rowKey);
    return key ?? undefined;
  }

  /** The chosen keys as a set, rebuilt when the array is replaced. */
  #selectedSet() {
    const keys = Array.isArray(this.selectedKeys) ? this.selectedKeys : [];
    const cached = this.#selectionCache;
    if (cached !== undefined && cached.keys === this.selectedKeys) return cached.set;
    const set = new Set(keys);
    this.#selectionCache = { keys: this.selectedKeys, set };
    return set;
  }

  /**
   * The selected rows this table is holding, in row order.
   *
   * A key whose row is not loaded is absent here and still selected. A server
   * table pages through a collection it never holds all of, so the keys are the
   * selection and these are the rows it can hand over now.
   */
  get selectedRows() {
    const set = this.#selectedSet();
    if (set.size === 0) return [];
    return this.rows.filter((row, index) => {
      const key = this.#identity(row, index);
      return key !== undefined && set.has(key);
    });
  }

  get selectionCount() {
    return this.#selectedSet().size;
  }

  /**
   * How many rows on this page may be chosen, and how many are.
   *
   * Cached on what `visibleRows` is derived from, because the header asks three
   * questions of it per render and `pagination="none"` puts every supplied row on
   * the page. `processedRows` is itself cached, so the identity check is the
   * whole comparison rather than a re-filter.
   */
  #pageSelection() {
    const rows = this.processedRows;
    const cached = this.#pageSelectionCache;
    if (
      cached !== undefined &&
      cached.rows === rows &&
      cached.keys === this.selectedKeys &&
      cached.predicate === this.rowSelectable &&
      cached.page === this.page &&
      cached.pageSize === this.validPageSize &&
      cached.mode === this.normalizedMode
    ) {
      return cached.value;
    }

    const set = this.#selectedSet();
    let selectable = 0;
    let selected = 0;
    this.visibleRows.forEach((row, index) => {
      if (!this.canSelectRow(row, index)) return;
      selectable += 1;
      const key = this.#identity(row, index);
      if (key !== undefined && set.has(key)) selected += 1;
    });

    const value = { selectable, selected };
    this.#pageSelectionCache = {
      rows,
      keys: this.selectedKeys,
      predicate: this.rowSelectable,
      page: this.page,
      pageSize: this.validPageSize,
      mode: this.normalizedMode,
      value,
    };
    return value;
  }

  get allPageRowsSelected() {
    const { selectable, selected } = this.#pageSelection();
    return selectable > 0 && selected === selectable;
  }

  /** Some but not all, which is what the header checkbox shows as indeterminate. */
  get somePageRowsSelected() {
    const { selectable, selected } = this.#pageSelection();
    return selected > 0 && selected < selectable;
  }

  get selectAllDisabled() {
    return this.loading || this.#pageSelection().selectable === 0;
  }

  /** @param {unknown} row @param {number} index */
  isSelected(row, index) {
    const key = this.#identity(row, index);
    return key !== undefined && this.#selectedSet().has(key);
  }

  /** @param {unknown} row @param {number} index */
  canSelectRow(row, index) {
    if (!this.selectable || this.#identity(row, index) === undefined) return false;
    return this.rowSelectable?.(row, index) ?? true;
  }

  /**
   * Toggle one row, or every row between the last one chosen and this one.
   *
   * A shift range applies the state the clicked row is moving to, so shift-click
   * after a plain click selects the span and shift-click on a selected row clears
   * it. The range covers the current page, since that is what the user can see;
   * rows `rowSelectable` refuses are stepped over rather than flipped.
   *
   * @param {unknown} row @param {number} index @param {MouseEvent} [event]
   */
  toggleRow(row, index, event) {
    if (!this.canSelectRow(row, index)) return;
    const key = this.#identity(row, index);
    if (key === undefined) return;

    const next = new Set(this.#selectedSet());
    const select = !next.has(key);
    const anchor = event?.shiftKey === true ? this.#anchorIndex() : -1;
    const rows = this.visibleRows;
    const from = anchor < 0 ? index : Math.min(anchor, index);
    const to = anchor < 0 ? index : Math.max(anchor, index);
    for (let position = from; position <= to; position += 1) {
      const candidate = rows[position];
      if (candidate === undefined || !this.canSelectRow(candidate, position)) continue;
      const candidateKey = this.#identity(candidate, position);
      if (candidateKey === undefined) continue;
      if (select) next.add(candidateKey);
      else next.delete(candidateKey);
    }

    this.#selectionAnchor = key;
    this.#commitSelection(next);
  }

  /** Choose every selectable row on this page, or clear them when all are chosen. */
  toggleAllOnPage() {
    const { selectable, selected } = this.#pageSelection();
    if (selectable === 0) return;
    const next = new Set(this.#selectedSet());
    const select = selected < selectable;
    this.visibleRows.forEach((row, index) => {
      if (!this.canSelectRow(row, index)) return;
      const key = this.#identity(row, index);
      if (key === undefined) return;
      if (select) next.add(key);
      else next.delete(key);
    });
    this.#selectionAnchor = undefined;
    this.#commitSelection(next);
  }

  /** Drop the whole selection. What a bulk action calls once its write has landed. */
  clearSelection() {
    this.#selectionAnchor = undefined;
    this.#commitSelection(new Set());
  }

  /** Where the shift anchor sits on this page, or -1 when it is not on it. */
  #anchorIndex() {
    const anchor = this.#selectionAnchor;
    if (anchor === undefined) return -1;
    return this.visibleRows.findIndex((row, index) => this.#identity(row, index) === anchor);
  }

  /**
   * Drop keys whose rows are gone.
   *
   * Only where this table was given the whole collection. In `server` mode `rows`
   * is one page, so a key absent from it means "on another page", and pruning
   * would empty the selection on every page change, which is the one thing keying
   * it exists to prevent.
   */
  #pruneSelection() {
    if (this.normalizedMode === 'server') return;
    const set = this.#selectedSet();
    if (set.size === 0) return;

    /** @type {Set<unknown>} */
    const live = new Set();
    this.rows.forEach((row, index) => {
      const key = this.#identity(row, index);
      if (key !== undefined && set.has(key)) live.add(key);
    });
    if (live.size === set.size) return;
    this.#commitSelection(new Set([...set].filter((key) => live.has(key))));
  }

  /** @param {ReadonlySet<unknown>} next */
  #commitSelection(next) {
    const keys = Object.freeze([...next]);
    const current = this.#selectedSet();
    if (keys.length === current.size && keys.every((key) => current.has(key))) return;

    this.selectedKeys = keys;
    this.#selectionCache = undefined;
    this.#pageSelectionCache = undefined;
    this.dispatchEvent(
      new CustomEvent('selection-change', {
        bubbles: true,
        detail: /** @type {TableSelection} */ ({ keys, rows: this.selectedRows, scope: 'loaded' }),
      }),
    );
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

  /**
   * Enter or Space on the row itself.
   *
   * The target is checked here as well as in `activate`, because the row is what
   * carries the handler and a keypress inside a cell reaches it by bubbling.
   * Preventing the default first would take Space away from the control the user
   * is actually on, such as a selection checkbox or a button a screen rendered in
   * a cell, and the row would refuse to activate anyway.
   *
   * @param {unknown} row @param {number} index @param {KeyboardEvent} event
   */
  activateFromKeyboard(row, index, event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (!this.interactive || isInteractiveTarget(event.target)) return;
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

  /* ── Row window ────────────────────────────────────────────────────────── */

  /**
   * Follow the scroller the window is measured against.
   *
   * The scroller is one static element in the template, so this normally binds
   * once and does nothing on every render after it. It rebinds when the node
   * changes and unbinds when `virtualized` is turned off, which is what makes the
   * property live rather than a construction-time choice.
   */
  #watchScroller() {
    const scroller = this.virtualized
      ? /** @type {HTMLElement | null} */ (this.querySelector('[data-ui-part="table-scroll"]'))
      : null;
    if (scroller === this.#scroller) return;

    this.#scrollController?.abort();
    this.#scrollController = undefined;
    this.#viewportObserver?.disconnect();
    this.#viewportObserver = undefined;
    this.#scroller = scroller;

    if (scroller === null) {
      this.#scrollTop = 0;
      this.#measuredViewport = 0;
      this.#measuredRowHeight = 0;
      return;
    }

    this.#scrollController = new AbortController();
    scroller.addEventListener('scroll', this.#onScroll, {
      passive: true,
      signal: this.#scrollController.signal,
    });

    if (typeof ResizeObserver === 'undefined') return;
    // A scroller that grows shows more rows without anything scrolling, so the
    // window has to move on a resize as well as on a scroll.
    this.#viewportObserver = new ResizeObserver(() => {
      this.#applyViewport(scroller.clientHeight);
    });
    this.#viewportObserver.observe(scroller);
  }

  /**
   * Send the window back to the first row when the page it is showing changes.
   *
   * A new page, sort or filter is a different list, and leaving the scroller where
   * it was would open it two thousand rows down. Arriving rows are deliberately
   * not on the list, because that is `infinite` mode extending the list the user
   * is already reading.
   *
   * @param {Map<PropertyKey, unknown>} changed
   */
  #rewindWindow(changed) {
    const scroller = this.#scroller;
    if (scroller === null || !this.#hasUpdated) return;
    const moved =
      changed.has('page') ||
      changed.has('pageSize') ||
      changed.has('sortKey') ||
      changed.has('sortDirection') ||
      changed.has('filters');
    if (!moved || this.#scrollTop === 0) return;
    this.#scrollTop = 0;
    scroller.scrollTop = 0;
    this.requestUpdate();
  }

  /**
   * Read the two lengths the window arithmetic needs from what was just rendered.
   *
   * Both converge. A measurement that moves the window causes one more render,
   * which measures the same numbers and stops. The row height is taken from a
   * rendered row rather than from `row-height`, so a screen whose cells are taller
   * than it declared still gets spacers that match its scrollbar.
   */
  #measureWindow() {
    const scroller = this.#scroller;
    if (scroller === null) return;
    this.#applyViewport(scroller.clientHeight);

    const row = this.querySelector('[data-ui-part="table-row"]');
    if (row === null) return;
    const height = Math.round(row.getBoundingClientRect().height);
    if (height <= 0 || height === this.#measuredRowHeight) return;
    this.#measuredRowHeight = height;
    this.requestUpdate();
  }

  /** @param {number} height */
  #applyViewport(height) {
    const measured = Math.round(height);
    if (measured <= 0 || measured === this.#measuredViewport) return;
    const before = this.#window();
    this.#measuredViewport = measured;
    if (this.#windowMoved(before)) this.requestUpdate();
  }

  #onScroll = () => {
    const scroller = this.#scroller;
    if (scroller === null) return;
    const top = Math.max(0, Math.round(scroller.scrollTop));
    if (top === this.#scrollTop) return;

    const before = this.#window();
    this.#scrollTop = top;
    const after = this.#window();
    if (after.start === before.start && after.end === before.end) return;

    this.#planFocusRecovery(after);
    this.#requestMoreAtWindowEnd(after);
    this.requestUpdate();
  };

  /**
   * Whether the window changed since `before` was computed.
   *
   * @param {{ start: number, end: number }} before
   */
  #windowMoved(before) {
    const after = this.#window();
    return after.start !== before.start || after.end !== before.end;
  }

  /**
   * In `infinite` mode a bounded scroller puts the load-more sentinel permanently
   * below the fold, where an intersection observer would either never fire or fire
   * forever. The window already knows how close the user is to the last loaded
   * row, so it asks instead.
   *
   * @param {{ end: number }} window
   */
  #requestMoreAtWindowEnd(window) {
    if (!this.showInfiniteControl) return;
    if (window.end < this.visibleRows.length - WINDOW_OVERSCAN) return;
    this.requestMore();
  }

  /**
   * Note the row a scroll is about to unmount from under the keyboard.
   *
   * Focus in a removed row falls to `document.body`, which drops the user out of
   * the table entirely. Focus keeps its kind and moves to the nearest row that
   * survives, so a focused row becomes the edge row and a focused selection
   * checkbox becomes that row's checkbox.
   *
   * @param {{ start: number, end: number }} after
   */
  #planFocusRecovery(after) {
    const active = document.activeElement;
    if (active === null || !this.contains(active)) return;
    const row = active.closest('[data-ui-part="table-row"]');
    if (row === null) return;

    const index = Number(row.getAttribute('data-row-index'));
    if (!Number.isInteger(index) || (index >= after.start && index < after.end)) return;
    this.#focusRecovery = {
      index: Math.min(Math.max(index, after.start), after.end - 1),
      part: active.getAttribute('data-ui-part') ?? '',
    };
  }

  /** Hand focus to the surviving row `#planFocusRecovery` chose, if there was one. */
  #restoreWindowFocus() {
    const plan = this.#focusRecovery;
    if (plan === undefined) return;
    this.#focusRecovery = undefined;

    const row = this.querySelector(`[data-ui-part="table-row"][data-row-index="${String(plan.index)}"]`);
    const inner = plan.part === '' ? null : row?.querySelector(`[data-ui-part="${plan.part}"]`);
    // `preventScroll`, or focusing the row scrolls it into view, which moves the
    // window, which recovers focus again.
    for (const candidate of [inner, row, this.#scroller]) {
      if (!(candidate instanceof HTMLElement)) continue;
      candidate.focus({ preventScroll: true });
      if (document.activeElement === candidate) return;
    }
  }

  /**
   * Watch the sentinel that asks for the next page when it scrolls into view.
   *
   * Called from `updated`, so it runs on every render, including the renders the
   * arriving rows themselves cause. Rebuilding the observer each time would
   * disconnect and reconstruct it while the user is still scrolling toward it, and
   * a fresh observer reports its first intersection asynchronously, which loses
   * the one thing this exists to notice. The sentinel element survives re-renders,
   * so the observer is rebuilt only when the node it watches changes.
   */
  #watchInfiniteSentinel() {
    const sentinel =
      this.showInfiniteControl && !this.virtualized && typeof IntersectionObserver !== 'undefined'
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
   * revision is read after it. The lazy reconcile is how a table whose columns
   * arrived before its persisted state gets an order at all, so it has to be able
   * to make the projection stale.
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
   * Mark the projection stale. Cheap on purpose, because every mutation that feeds
   * the projection calls it, including one per pointer move during a resize drag.
   * The rebuild happens once on the next read rather than once per call.
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
    // A windowed table is its own scroller, so the header sticks to the top of it
    // rather than scrolling out of the viewport the window is measured against. One
    // element can stick on both axes. The four layers, top down, are header over a
    // sticky column, header, sticky cell, ordinary cell.
    const stuckDown = header && this.virtualized;
    if (position !== '' || stuckDown) {
      declarations.push('position:sticky');
      if (position !== '') {
        declarations.push(
          `${position === 'start' ? 'inset-inline-start' : 'inset-inline-end'}:${String(
            presentation.stickyOffsets.get(column) ?? 0,
          )}px`,
        );
      }
      if (stuckDown) declarations.push('top:0');
      declarations.push(
        `z-index:${String(header ? (position === '' ? 3 : 4) : 2)}`,
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
 * Filters as JSON keep `key`, `value` and `match`, and drop every `predicate`,
 * because a function has no JSON form. A descriptor whose comparison came from its
 * rule type restores intact, and one carrying a hand-written predicate restores as
 * a plain `match`. That is one more reason the rule types imply their own
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
 * How far each sticky column sits from its own edge, which is the summed width of
 * the sticky columns between it and that edge.
 *
 * One pass per side over the visible columns, rather than one walk per column
 * asking the same question. At twenty-four columns with twelve sticky that is two
 * passes instead of twelve walks, and each cell then reads a map.
 *
 * The `has` guard keeps the answer a per-column walk would give, because that walk
 * stops at the first column identical to the one it was asked about. A column
 * appearing twice, which only a duplicate `key` produces, keeps its first
 * offset.
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

// A table reads its `<ui-table-column>` children, so that element existing is this
// component's dependency. `uses` says so as a value, where a side-effect import
// would not.
await defineComponent({
  tag: 'ui-table',
  element: UiTable,
  module: import.meta.url,
  uses: [UiTableColumn],
});
