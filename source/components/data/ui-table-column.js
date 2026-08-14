import { defineComponent } from '@core/elements/component.js';

/**
 * Declarative column metadata consumed by `<ui-table>`.
 *
 * Keep columns beside table use, like CDK column definitions, without teaching
 * template compiler cross-component lexical scopes. Rich cells use `renderer`:
 * a function receiving `(row, rowIndex, value)` and returning any Lit-renderable
 * value. `sortValue` and `filterValue` expose orthogonal values when rendered
 * content is not suitable for local sorting/filtering. Plain columns need only
 * `key` and `label`.
 */
export class UiTableColumn extends HTMLElement {
  static observedAttributes = [
    'key',
    'label',
    'header-class',
    'cell-class',
    'sortable',
    'sort-key',
    'sort-start',
    'hidden',
    'hideable',
    'locked',
    'resizable',
    'width',
    'min-width',
    'max-width',
    'sticky',
  ];

  /** @type {((row: unknown, rowIndex: number, value: unknown) => unknown) | undefined} */
  #renderer;

  /** @type {((row: unknown, rowIndex: number, value: unknown) => unknown) | undefined} */
  #sortValue;

  /** @type {((row: unknown, rowIndex: number, value: unknown) => unknown) | undefined} */
  #filterValue;

  connectedCallback() {
    this.#notify();
  }

  /** @param {string} _name @param {string | null} _old @param {string | null} _next */
  attributeChangedCallback(_name, _old, _next) {
    if (this.isConnected) this.#notify();
  }

  get key() {
    return this.getAttribute('key') ?? '';
  }

  get label() {
    return this.getAttribute('label') ?? '';
  }

  get headerClass() {
    return this.getAttribute('header-class') ?? '';
  }

  get cellClass() {
    return this.getAttribute('cell-class') ?? '';
  }

  get sortable() {
    return this.hasAttribute('sortable');
  }

  get sortKey() {
    return this.getAttribute('sort-key') || this.key;
  }

  get sortStart() {
    return this.getAttribute('sort-start') === 'desc' ? 'desc' : 'asc';
  }

  /** Initially hidden. Persisted table state overrides this default. */
  get hiddenByDefault() {
    return this.hasAttribute('hidden');
  }

  /** Opts this column into the table's chooser. */
  get hideable() {
    return this.hasAttribute('hideable') && !this.locked;
  }

  /** Prevents user reorder, resize, hide, and sticky changes. */
  get locked() {
    return this.hasAttribute('locked');
  }

  /** Allows resize even when table-wide resizing is off. */
  get resizable() {
    return this.hasAttribute('resizable') && !this.locked;
  }

  get width() {
    return positiveNumber(this.getAttribute('width'));
  }

  get minWidth() {
    return positiveNumber(this.getAttribute('min-width')) ?? 64;
  }

  get maxWidth() {
    return Math.max(this.minWidth, positiveNumber(this.getAttribute('max-width')) ?? 1600);
  }

  /** @returns {'start' | 'end' | ''} */
  get sticky() {
    const value = this.getAttribute('sticky');
    return value === 'start' || value === 'end' ? value : '';
  }

  get renderer() {
    return this.#renderer;
  }

  set renderer(value) {
    this.#renderer = typeof value === 'function' ? value : undefined;
    if (this.isConnected) this.#notify();
  }

  get sortValue() {
    return this.#sortValue;
  }

  set sortValue(value) {
    this.#sortValue = typeof value === 'function' ? value : undefined;
    if (this.isConnected) this.#notify();
  }

  get filterValue() {
    return this.#filterValue;
  }

  set filterValue(value) {
    this.#filterValue = typeof value === 'function' ? value : undefined;
    if (this.isConnected) this.#notify();
  }

  #notify() {
    this.dispatchEvent(new CustomEvent('ui-column-change', { bubbles: true }));
  }
}

/** @param {string | null} value */
function positiveNumber(value) {
  if (value === null) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

// A definition like every other component's, even though this element renders
// nothing: it is the record a page's `uses: [UiTableColumn]` resolves against, and
// what makes `<ui-table-column>` a tag the template checker accepts in that page
// and refuses in one that never imported it. `template: false` — this element is
// column metadata its parent reads, and has no markup of its own.
await defineComponent({
  tag: 'ui-table-column',
  element: UiTableColumn,
  module: import.meta.url,
  template: false,
});
