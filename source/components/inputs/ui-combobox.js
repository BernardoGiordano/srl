import { nothing } from 'lit';
import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { anchorPanel } from '../internal/anchored-panel.js';
import { standardText } from '../internal/text.js';
import { nextElementId, optionalAttr } from '../internal/dom.js';

/**
 * @typedef {{
 *   value: unknown,
 *   label: string,
 *   group?: string,
 *   disabled?: boolean,
 *   data?: unknown,
 * }} ComboboxOption
 * @typedef {{
 *   option: ComboboxOption,
 *   id: string,
 *   selected: string,
 *   disabled: string,
 *   active: boolean,
 *   expanded: boolean,
 *   expansion: unknown,
 * }} ComboboxRow
 * @typedef {{ key: string, group: string, rows: ComboboxRow[] }} ComboboxSection
 */

/**
 * A searchable select: chips for what is chosen, a text input, and a panel of
 * options underneath.
 *
 * Options are data, not markup. `<ui-table-column>` is declarative because a
 * consumer authors columns by hand; nobody authors eight thousand `<option>`
 * elements, and the interesting sources — a fetch, a typeahead — produce arrays.
 *
 * Everything visual is the consumer's. Rich option and chip content arrive as
 * `optionRenderer` / `chipRenderer` callbacks, the same escape hatch `ui-table`
 * gives cells, which is why this component can carry a spinner inside an option
 * without knowing what a spinner is.
 *
 * No text is shipped. What the control says about itself is standard text
 * resolved through `text.js`; what names the data — the not-found line, the
 * add-tag prefix, the label and the placeholder — stays a property.
 */
export class UiCombobox extends SignalElement {
  static properties = {
    options: { attribute: false },
    value: { attribute: false },
    multiple: { type: Boolean, reflect: true },
    searchable: { type: Boolean },
    hideSelected: { type: Boolean, attribute: 'hide-selected' },
    clearSearchOnAdd: { type: Boolean, attribute: 'clear-search-on-add' },
    clearable: { type: Boolean },
    open: { type: Boolean, reflect: true, attribute: 'data-open' },
    loading: { type: Boolean, reflect: true },
    disabled: { type: Boolean, reflect: true },
    searchTerm: { state: true },
    searchFn: { attribute: false },
    compareWith: { attribute: false },
    addTag: { attribute: false },
    optionRenderer: { attribute: false },
    expandedOption: { attribute: false },
    optionExpansion: { attribute: false },
    chipRenderer: { attribute: false },
    groupRenderer: { attribute: false },
    notFoundRenderer: { attribute: false },
    label: { type: String },
    placeholder: { type: String },
    notFoundLabel: { type: String, attribute: 'not-found-label' },
    addTagLabel: { type: String, attribute: 'add-tag-label' },
    controlClass: { type: String, attribute: 'control-class' },
    inputClass: { type: String, attribute: 'input-class' },
    panelClass: { type: String, attribute: 'panel-class' },
    chipClass: { type: String, attribute: 'chip-class' },
    optionClass: { type: String, attribute: 'option-class' },
    /*
     * Written by `ui-field` through the form-control contract, never by a
     * template. Declared as state so a change re-renders the inner input, which
     * is the node that actually carries the ARIA.
     */
    formInvalid: { state: true },
    formDescribedBy: { state: true },
    formLabelledBy: { state: true },
  };

  /** @type {readonly ComboboxOption[]} */
  options = [];

  /** @type {readonly ComboboxOption[]} */
  value = [];

  multiple = false;
  searchable = true;

  /** Selected options disappear from the panel. Off, because a filter disables them instead. */
  hideSelected = false;

  /**
   * Off on purpose, and the opposite of ng-select's default. Keeping the term
   * after a selection is what lets a user pick three results out of one
   * typeahead search; clearing it throws the result list away after the first.
   */
  clearSearchOnAdd = false;

  clearable = true;
  open = false;
  loading = false;
  disabled = false;
  searchTerm = '';

  /** @type {((term: string, option: ComboboxOption) => boolean) | undefined} */
  searchFn;

  /** @type {((left: ComboboxOption, right: ComboboxOption) => boolean) | undefined} */
  compareWith;

  /**
   * Turns the typed term into an option, or returns undefined to refuse it. The
   * consumer is expected to append the option to `options` as well, exactly as
   * ng-select's `addTag` contract does.
   *
   * @type {((term: string) => ComboboxOption | undefined) | undefined}
   */
  addTag;

  /** @type {((option: ComboboxOption) => unknown) | undefined} */
  optionRenderer;

  /**
   * The one row currently showing its expansion, or nothing.
   *
   * A property rather than something the renderer decides on its own, because
   * "which row is open" is state this component has to react to: a consumer that
   * only flipped a flag of its own would change what `optionExpansion` returns
   * without anything here knowing the panel needs re-rendering.
   *
   * @type {ComboboxOption | undefined}
   */
  expandedOption;

  /**
   * Extra content for the expanded row, rendered in its own block under the
   * option rather than inside it.
   *
   * This is what lets an option *be* a small form — a date range picked in place
   * — without the combobox knowing what a date is, and without putting form
   * controls inside a `role="option"`, where a screen reader would read them as
   * part of the choice.
   *
   * @type {((option: ComboboxOption) => unknown) | undefined}
   */
  optionExpansion;

  /** @type {((option: ComboboxOption) => unknown) | undefined} */
  chipRenderer;

  /** @type {((group: string) => unknown) | undefined} */
  groupRenderer;

  /** @type {((term: string) => unknown) | undefined} */
  notFoundRenderer;

  label = '';
  placeholder = '';

  /**
   * The two strings that name what is being searched rather than the control
   * doing the searching: "No comune matches", `Search comuni "mil"`. Empty falls
   * back to `ui.combobox.notFound` / `ui.combobox.addTag`.
   */
  notFoundLabel = '';
  addTagLabel = '';

  controlClass = '';
  inputClass = '';
  panelClass = '';
  chipClass = '';
  optionClass = '';

  formInvalid = false;
  formDescribedBy = '';
  formLabelledBy = '';

  /**
   * Codes set through `formValue` that have not been matched to an option yet.
   * Undefined means there is nothing outstanding.
   *
   * @type {string[] | undefined}
   */
  #pendingCodes;

  #id = nextElementId('ui-combobox');

  /** @type {ComboboxOption | undefined} */
  #active;

  #panelScrollTop = 0;

  #scrollActivePending = false;

  /** @type {(() => void) | undefined} */
  #release;

  /** @type {HTMLElement | undefined} */
  #anchored;

  #expanded = false;

  #expandedHeight = -1;

  /** @type {{
   *   options: readonly ComboboxOption[],
   *   value: readonly ComboboxOption[],
   *   term: string,
   *   searchFn: UiCombobox['searchFn'],
   *   hideSelected: boolean,
   *   result: readonly ComboboxOption[],
   * } | undefined} */
  #visibleCache;

  connectedCallback() {
    super.connectedCallback();
    // pointerdown, not click, for the reason ui-menu documents: a drag that ends
    // outside the panel must not close it mid-gesture.
    document.addEventListener('pointerdown', this.#onDocumentPointerDown, { signal: this.lifetime });
  }

  get inputId() {
    return `${this.#id}-input`;
  }

  /* ── The form-control contract ──────────────────────────────────────────── */

  /**
   * The selection as *codes*, which is what a form field holds: a string when
   * single, an array of them when `multiple`. `value` stays the option objects,
   * because a chip needs the label and an option renderer needs the whole thing.
   *
   * This asymmetry is the reason `form-control.js` exists. A screen wiring this
   * element by hand had to map both ways at every site; now the mapping lives
   * once, here, beside the data it maps.
   *
   * @type {string | readonly string[]}
   */
  get formValue() {
    const codes = this.selected.map((option) => String(option.value));
    return this.multiple ? codes : (codes[0] ?? '');
  }

  set formValue(next) {
    this.#pendingCodes = typeof next === 'string' ? (next === '' ? [] : [next]) : [...next].map(String);
    this.#applyCodes();
  }

  /** @type {string} */
  get formEvent() {
    return 'selection-change';
  }

  focusControl() {
    this.focusInput();
  }

  /** @param {boolean} invalid */
  setInvalid(invalid) {
    this.formInvalid = invalid;
  }

  /** @param {string} id */
  setDescribedBy(id) {
    this.formDescribedBy = id;
  }

  /** @param {string} id */
  setLabelledBy(id) {
    this.formLabelledBy = id;
  }

  /**
   * The same switch a consumer sets as an attribute. A form owns it while the
   * element is bound to a field, which is no more surprising than the form
   * owning the value.
   *
   * @param {boolean} disabled
   */
  setDisabled(disabled) {
    this.disabled = disabled;
  }

  /** @returns {string | typeof nothing} */
  get invalidAttr() {
    return this.formInvalid ? 'true' : nothing;
  }

  get describedByAttr() {
    return optionalAttr(this.formDescribedBy);
  }

  get labelledByAttr() {
    return optionalAttr(this.formLabelledBy);
  }

  /**
   * Resolve the codes a form set against the options that exist now.
   *
   * A code with no matching option is *kept pending* rather than dropped, so the
   * value survives a later-arriving lookup. It is dropped from the selection in
   * the meantime, because rendering a chip for an option whose label is unknown
   * would show the user a code.
   */
  #applyCodes() {
    const codes = this.#pendingCodes;
    if (codes === undefined) return;
    const options = this.normalizedOptions;
    const matched = codes
      .map((code) => options.find((option) => String(option.value) === code))
      .filter((option) => option !== undefined);

    // Every code resolved, so nothing is left to wait for. Until then the codes
    // stay, and the next `options` change tries again.
    if (matched.length === codes.length) this.#pendingCodes = undefined;

    if (!sameOptions(this.selected, matched)) this.value = matched;
  }

  get panelId() {
    return `${this.#id}-panel`;
  }

  get normalizedOptions() {
    return Array.isArray(this.options) ? /** @type {readonly ComboboxOption[]} */ (this.options) : [];
  }

  get selected() {
    return Array.isArray(this.value) ? /** @type {readonly ComboboxOption[]} */ (this.value) : [];
  }

  /**
   * What the control renders as chips, which is the selection only when there can
   * be more than one of it.
   *
   * A chip earns its place by being removable *individually*, and a single-choice
   * control has nothing to individuate: its one chip carried a `×` that did exactly
   * what the clear button beside it did, so the field offered the same action twice
   * and looked like a filter rather than a value. Single choice puts its label in
   * the input instead — see `inputText` — which is what a `<select>` does and what
   * a form asking one question should look like.
   *
   * @returns {readonly ComboboxOption[]}
   */
  get chips() {
    return this.multiple ? this.selected : [];
  }

  /**
   * The text in the control's input.
   *
   * Multiple choice: always the search term, because the selection is beside it in
   * chips. Single choice: the term while the panel is open, and the chosen label
   * when it is closed. The panel is what separates the two — `closePanel` clears
   * the term, and `onFocus` opens it — so the label can never be half-edited into a
   * search, and a search can never be mistaken for a value.
   *
   * `option.label` rather than `renderChip`: this is an input's value, so it has to
   * be a string, and a `chipRenderer` may return a template.
   *
   * @returns {string}
   */
  get inputText() {
    if (this.multiple || this.open) return this.searchTerm;
    const [option] = this.selected;
    return option === undefined ? '' : String(option.label ?? '');
  }

  get term() {
    return this.searchTerm.trim();
  }

  get visibleOptions() {
    const term = this.term;
    const cached = this.#visibleCache;
    if (
      cached !== undefined &&
      cached.options === this.options &&
      cached.value === this.value &&
      cached.term === term &&
      cached.searchFn === this.searchFn &&
      cached.hideSelected === this.hideSelected
    ) {
      return cached.result;
    }

    let result = this.normalizedOptions;
    if (this.hideSelected) result = result.filter((option) => !this.isSelected(option));
    if (term !== '') {
      const search = this.searchFn ?? defaultSearch;
      result = result.filter((option) => search(term, option));
    }

    this.#visibleCache = {
      options: this.options,
      value: this.value,
      term,
      searchFn: this.searchFn,
      hideSelected: this.hideSelected,
      result,
    };
    return result;
  }

  /**
   * The panel, pre-chewed. Ids, `aria-selected`, `aria-disabled` and the active
   * flag are computed here rather than in the template, so the markup contains no
   * lookups and an option's identity survives a re-render.
   *
   * @returns {ComboboxSection[]}
   */
  get sections() {
    /** @type {Map<string, ComboboxSection>} */
    const sections = new Map();
    const visible = this.visibleOptions;
    for (const [index, option] of visible.entries()) {
      const group = option.group ?? '';
      let section = sections.get(group);
      if (section === undefined) {
        section = { key: group, group, rows: [] };
        sections.set(group, section);
      }
      const expansion = this.isExpanded(option) ? this.optionExpansion?.(option) : undefined;
      section.rows.push({
        option,
        id: `${this.#id}-option-${String(index)}`,
        selected: String(this.isSelected(option)),
        disabled: String(option.disabled === true),
        active: option === this.#active,
        expanded: expansion !== undefined && expansion !== nothing,
        expansion,
      });
    }
    return [...sections.values()];
  }

  get activeDescendant() {
    if (!this.open || this.#active === undefined) return nothing;
    const index = this.visibleOptions.indexOf(this.#active);
    return index === -1 ? nothing : `${this.#id}-option-${String(index)}`;
  }

  get expandedAttr() {
    return String(this.open);
  }

  get labelAttr() {
    return optionalAttr(this.label);
  }

  /**
   * Shown when the control has nothing of its own to say: no chips beside the input
   * and no text in it. Keyed on what is rendered rather than on the selection, so a
   * single-choice control that has emptied its input to be searched prompts again
   * instead of sitting blank.
   */
  get placeholderAttr() {
    return this.chips.length === 0 && this.inputText === '' && this.placeholder !== ''
      ? this.placeholder
      : nothing;
  }

  get multiselectableAttr() {
    return this.multiple ? 'true' : nothing;
  }

  get hasSelection() {
    return this.selected.length > 0;
  }

  get showClear() {
    return this.clearable && this.hasSelection && !this.disabled;
  }

  /**
   * A tag is offered when the term names nothing already listed. Comparing the
   * label rather than the value is deliberate: the consumer's `addTag` decides
   * what the value becomes, and it has not run yet.
   */
  get showAddTag() {
    if (typeof this.addTag !== 'function' || this.term === '') return false;
    const term = this.term.toLocaleLowerCase();
    return !this.visibleOptions.some((option) => String(option.label).toLocaleLowerCase() === term);
  }

  get showNotFound() {
    return !this.loading && this.visibleOptions.length === 0 && !this.showAddTag;
  }

  get notFoundContent() {
    return (
      this.notFoundRenderer?.(this.term) ??
      (this.notFoundLabel === '' ? this.text('notFound') : this.notFoundLabel)
    );
  }

  get addTagContent() {
    const prefix = this.addTagLabel === '' ? this.text('addTag') : this.addTagLabel;
    return prefix === '' ? this.term : `${prefix} "${this.term}"`;
  }

  /** @param {ComboboxOption} option */
  isSelected(option) {
    const same = this.compareWith ?? Object.is;
    return this.selected.some((candidate) => same(candidate, option));
  }

  /** @param {ComboboxOption} option */
  isExpanded(option) {
    if (this.expandedOption === undefined) return false;
    const same = this.compareWith ?? Object.is;
    return same(this.expandedOption, option);
  }

  /** @param {ComboboxOption} option */
  renderOption(option) {
    return this.optionRenderer?.(option) ?? option.label ?? nothing;
  }

  /** @param {ComboboxOption} option */
  renderChip(option) {
    return this.chipRenderer?.(option) ?? option.label ?? nothing;
  }

  /** @param {string} group */
  renderGroup(group) {
    return this.groupRenderer?.(group) ?? group;
  }

  /**
   * Standard interaction text, from `ui.combobox.*`. See `text.js`: what a
   * combobox says about itself is the same on every screen, so only the two
   * strings that name the *data* — nothing found, add this tag — stay properties.
   *
   * @param {string} name
   * @returns {string}
   */
  text(name) {
    return standardText('combobox', name);
  }

  /** @param {ComboboxOption} option */
  removeAria(option) {
    const remove = this.text('remove');
    return remove === '' ? nothing : `${remove} ${String(option.label)}`;
  }

  onDestroy() {
    this.#release?.();
    this.#release = undefined;
    this.#anchored = undefined;
  }

  /** @param {Map<PropertyKey, unknown>} changed */
  updated(changed) {
    super.updated(changed);

    // Switched off with the panel open — a form disabling itself as it starts to
    // save, most often, while the user was still choosing. `openPanel` refuses
    // to open a disabled control; nothing else was closing one.
    if (this.disabled && this.open) this.closePanel();

    // A form fills its fields from a record that arrives before the lookup that
    // explains it: `formValue = 'IT'` can be set while `options` is still empty.
    // The codes are kept and resolved here, whenever the options turn up.
    if (changed.has('options') && this.#pendingCodes !== undefined) this.#applyCodes();

    this.#anchorPanel();

    if (!this.open) {
      this.#panelScrollTop = 0;
      this.#expanded = false;
      return;
    }

    if (this.#active !== undefined && !this.visibleOptions.includes(this.#active)) {
      this.#active = undefined;
    }

    const panel = this.#panel;
    if (panel === null) return;

    if (this.#scrollActivePending) {
      this.#scrollActivePending = false;
      this.#scrollActiveIntoView(panel);
      return;
    }

    // A panel that grew a hundred options — a lazy rule finishing its load — is
    // re-laid-out by the browser with scrollTop clamped or reset. Putting it back
    // is what stops the list jumping to the top under the pointer, which is the
    // bug the Angular version worked around with two try/catch helpers.
    if (this.#panelScrollTop > 0 && panel.scrollTop === 0) {
      panel.scrollTop = this.#panelScrollTop;
    }

    this.#scrollExpansionIntoView(panel);
  }

  /**
   * An expansion that just opened is brought into view, row and all.
   *
   * Nothing else does this. The expansion's own content may take focus, and a
   * focused input does scroll itself into view — but only itself, which leaves the
   * row that opened it above the fold, and re-rendering the list around it resets
   * `scrollTop` afterwards anyway.
   *
   * @param {HTMLElement} panel
   */
  #scrollExpansionIntoView(panel) {
    const expansion = panel.querySelector('[data-ui-part="combobox-option-expansion"]');
    if (!(expansion instanceof HTMLElement)) {
      this.#expanded = false;
      this.#expandedHeight = -1;
      return;
    }
    if (this.#expanded) return;

    // The expansion's content is very likely a custom element, which renders in
    // its own update a frame or two after this one — so the first height read here
    // is 0, the second is half a form, and scrolling to either puts the wrong
    // thing at the fold. Measure until the number stops changing, then commit.
    const height = expansion.offsetHeight;
    if (height === 0 || height !== this.#expandedHeight) {
      this.#expandedHeight = height;
      requestAnimationFrame(() => {
        const current = this.#panel;
        if (current !== null) this.#scrollExpansionIntoView(current);
      });
      return;
    }
    this.#expanded = true;
    const row = expansion.previousElementSibling;
    const top = offsetWithin(panel, row instanceof HTMLElement ? row : expansion);
    const bottom = offsetWithin(panel, expansion) + expansion.offsetHeight;
    if (bottom > panel.scrollTop + panel.clientHeight) {
      panel.scrollTop = bottom - panel.clientHeight;
    }
    // Second, and deliberately: with both ends off-screen the row wins, because a
    // form whose heading has scrolled away is a form with no name on it.
    if (top < panel.scrollTop) panel.scrollTop = top;
    this.#panelScrollTop = panel.scrollTop;
  }

  /** @returns {HTMLElement | null} */
  get #panel() {
    return this.querySelector('[data-ui-part="combobox-panel"]');
  }

  /**
   * The panel is taken out of the flow and pinned under the control, because a
   * dropdown that reflows the page is not a dropdown. `anchorPanel` also keeps it
   * out of every ancestor's `overflow: hidden`, which is the difference between a
   * component that works in a card and one that only works on a bare page.
   */
  #anchorPanel() {
    const panel = this.#panel;
    if (!this.open || panel === null) {
      this.#release?.();
      this.#release = undefined;
      this.#anchored = undefined;
      return;
    }
    // Lit reuses the panel element across renders, so this is a no-op on all but
    // the render that opened it — and the anchor keeps following on its own.
    if (panel === this.#anchored) return;
    const control = /** @type {HTMLElement | null} */ (
      this.querySelector('[data-ui-part="combobox-control"]')
    );
    if (control === null) return;
    this.#release?.();
    this.#release = anchorPanel(control, panel, { align: 'stretch', maxHeight: 288 });
    this.#anchored = panel;
  }

  /** @param {HTMLElement} panel */
  #scrollActiveIntoView(panel) {
    if (this.#active === undefined) return;
    const index = this.visibleOptions.indexOf(this.#active);
    if (index === -1) return;
    const element = panel.querySelector(`#${CSS.escape(`${this.#id}-option-${String(index)}`)}`);
    if (!(element instanceof HTMLElement)) return;
    const top = offsetWithin(panel, element);
    const bottom = top + element.offsetHeight;
    if (top < panel.scrollTop) panel.scrollTop = top;
    else if (bottom > panel.scrollTop + panel.clientHeight) {
      panel.scrollTop = bottom - panel.clientHeight;
    }
    this.#panelScrollTop = panel.scrollTop;
  }

  /** @param {Event} event */
  onPanelScroll(event) {
    const panel = event.currentTarget;
    if (panel instanceof HTMLElement) this.#panelScrollTop = panel.scrollTop;
  }

  /** @param {PointerEvent} event */
  #onDocumentPointerDown = (event) => {
    if (!this.open) return;
    const target = event.target;
    if (target instanceof Node && this.contains(target)) return;
    this.closePanel();
  };

  /**
   * Clicking the frame anywhere but on a button focuses the input and opens the
   * panel, which is what makes the whole control feel like one field.
   *
   * @param {PointerEvent} event
   */
  onControlPointerDown(event) {
    if (this.disabled) return;
    const target = event.target;
    if (target instanceof Element && target.closest('button') !== null) return;
    event.preventDefault();
    this.focusInput();
    this.openPanel();
  }

  focusInput() {
    /** @type {HTMLInputElement | null} */ (
      this.querySelector('[data-ui-part="combobox-input"]')
    )?.focus();
  }

  openPanel() {
    if (this.open || this.disabled) return;
    this.open = true;
    this.dispatchEvent(new CustomEvent('panel-open', { bubbles: true }));
  }

  closePanel() {
    if (!this.open) return;
    this.open = false;
    this.#active = undefined;
    // A term left in a closed control reads as a value that was never applied,
    // and it would silently scope the next opening of the panel. Reset first, so
    // a consumer handling `panel-close` sees the search already back to empty.
    this.#resetSearch();
    this.dispatchEvent(new CustomEvent('panel-close', { bubbles: true }));
  }

  togglePanel() {
    if (this.open) this.closePanel();
    else {
      this.focusInput();
      this.openPanel();
    }
  }

  /** @param {Event} event */
  onInput(event) {
    if (!(event.target instanceof HTMLInputElement)) return;
    this.searchTerm = event.target.value;
    this.#active = undefined;
    this.openPanel();
    this.#emitSearch();
  }

  onFocus() {
    this.openPanel();
  }

  /** @param {KeyboardEvent} event */
  onKeydown(event) {
    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        this.openPanel();
        this.#moveActive(1);
        break;
      }
      case 'ArrowUp': {
        event.preventDefault();
        this.openPanel();
        this.#moveActive(-1);
        break;
      }
      case 'Home': {
        if (!this.open) return;
        event.preventDefault();
        this.#activateEdge(1);
        break;
      }
      case 'End': {
        if (!this.open) return;
        event.preventDefault();
        this.#activateEdge(-1);
        break;
      }
      case 'Enter': {
        if (!this.open) return;
        event.preventDefault();
        if (this.#active !== undefined) this.toggleOption(this.#active);
        else if (this.showAddTag) this.commitTag();
        break;
      }
      case 'Escape': {
        if (!this.open) return;
        event.preventDefault();
        this.closePanel();
        break;
      }
      case 'Backspace': {
        // Only on an empty input, or every correction would eat a chip.
        if (this.searchTerm !== '' || !this.hasSelection) return;
        const last = this.selected.at(-1);
        if (last !== undefined) this.removeOption(last);
        break;
      }
      case 'Tab': {
        this.closePanel();
        break;
      }
      default:
        break;
    }
  }

  /** @param {number} step */
  #moveActive(step) {
    const visible = this.visibleOptions;
    if (visible.length === 0) return;
    const from = this.#active === undefined ? -1 : visible.indexOf(this.#active);
    let index = from;
    for (let attempt = 0; attempt < visible.length; attempt += 1) {
      index = (index + step + visible.length) % visible.length;
      const candidate = visible[index];
      if (candidate !== undefined && candidate.disabled !== true) {
        this.#setActive(candidate);
        return;
      }
    }
  }

  /** @param {number} direction 1 for the first enabled option, -1 for the last. */
  #activateEdge(direction) {
    const visible = direction === 1 ? this.visibleOptions : [...this.visibleOptions].reverse();
    const candidate = visible.find((option) => option.disabled !== true);
    if (candidate !== undefined) this.#setActive(candidate);
  }

  /** @param {ComboboxOption} option */
  #setActive(option) {
    this.#active = option;
    this.#scrollActivePending = true;
    this.requestUpdate();
  }

  /** @param {ComboboxOption} option @param {Event} event */
  onOptionPointerDown(option, event) {
    // Keeps focus in the input: a blurred input closes the panel and loses the term.
    event.preventDefault();
    if (option.disabled === true) return;
    this.toggleOption(option);
  }

  /** @param {Event} event */
  onAddTagPointerDown(event) {
    event.preventDefault();
    this.commitTag();
  }

  /** @param {ComboboxOption} option */
  toggleOption(option) {
    if (option.disabled === true) return;
    if (this.isSelected(option)) this.removeOption(option);
    else this.selectOption(option);
  }

  /** @param {ComboboxOption} option */
  selectOption(option) {
    if (this.disabled || option.disabled === true) return;
    const next = this.multiple ? [...this.selected, option] : [option];
    this.#commit(next, 'option-add', option);
    if (this.clearSearchOnAdd || !this.multiple) this.#resetSearch();
    if (!this.multiple) this.closePanel();
  }

  /** @param {ComboboxOption} option @param {Event} [event] */
  removeOption(option, event) {
    event?.stopPropagation();
    const same = this.compareWith ?? Object.is;
    const next = this.selected.filter((candidate) => !same(candidate, option));
    if (next.length === this.selected.length) return;
    this.#commit(next, 'option-remove', option);
  }

  clearSelection() {
    if (!this.hasSelection) return;
    this.value = [];
    this.dispatchEvent(new CustomEvent('selection-clear', { bubbles: true }));
    this.#emitSelectionChange();
    this.#resetSearch();
  }

  commitTag() {
    if (typeof this.addTag !== 'function') return;
    const option = this.addTag(this.term);
    if (option === undefined) return;
    // The consumer has just pushed this option into `options`; the cache
    // predates it and would filter the fresh option straight back out.
    this.#visibleCache = undefined;
    this.selectOption(option);
  }

  /**
   * @param {readonly ComboboxOption[]} next
   * @param {'option-add' | 'option-remove'} name
   * @param {ComboboxOption} option
   */
  #commit(next, name, option) {
    this.value = next;
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, detail: option }));
    this.#emitSelectionChange();
  }

  #emitSelectionChange() {
    this.dispatchEvent(new CustomEvent('selection-change', { bubbles: true, detail: this.selected }));
  }

  #resetSearch() {
    if (this.searchTerm === '') return;
    this.searchTerm = '';
    this.#emitSearch();
  }

  #emitSearch() {
    this.dispatchEvent(new CustomEvent('search-change', { bubbles: true, detail: this.term }));
  }
}

/**
 * Where `element` sits in `container`'s scrolled content.
 *
 * Measured from rectangles rather than `offsetTop`, which is relative to whichever
 * ancestor happens to be positioned. That was the panel's parent while the panel
 * sat in the flow and is the panel itself now that it floats, and code that
 * assumed either one silently scrolls to the wrong place when the other is true.
 *
 * @param {HTMLElement} container @param {HTMLElement} element
 */
function offsetWithin(container, element) {
  return (
    element.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
  );
}

/**
 * Same options, same order, by identity.
 *
 * Guards the assignment in `#applyCodes`: writing `value` re-renders and
 * invalidates the visible-option cache, and doing it on every update — which is
 * what an unconditional assignment means once a form is bound — turns typing in
 * the search box into a render loop.
 *
 * @param {readonly ComboboxOption[]} left
 * @param {readonly ComboboxOption[]} right
 */
function sameOptions(left, right) {
  return left.length === right.length && left.every((option, index) => option === right[index]);
}

/** @param {string} term @param {ComboboxOption} option */
function defaultSearch(term, option) {
  return String(option.label ?? '')
    .toLocaleLowerCase()
    .includes(term.toLocaleLowerCase());
}

await defineComponent({ tag: 'ui-combobox', element: UiCombobox, module: import.meta.url });
