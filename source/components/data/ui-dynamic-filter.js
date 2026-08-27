import { html, nothing } from 'lit';
import { schedule } from '@core/foundation/clock.js';
import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { loadPreference, savePreference } from '@core/preferences/persistence.js';
import { optionalAttr } from '../internal/dom.js';
import { compareValue, matchForRuleType } from './filter-descriptor.js';
import { UiDateRange, readRange } from '../inputs/ui-date-range.js';
import { UiCombobox } from '../inputs/ui-combobox.js';
import { standardText } from '../internal/text.js';

/** @import { ComboboxOption } from '../inputs/ui-combobox.js' */

/**
 * @typedef {{ value: unknown, label: string, group?: string, disabled?: boolean }} SelectItem
 * @typedef {{ signal: AbortSignal }} FilterLoadContext
 * @typedef {'boolean' | 'option' | 'date' | 'free' | 'children' | 'observer' | 'lazy' | 'typeahead' | 'daterange'} FilterRuleType
 *
 * @typedef {{ label: string, value: string, default?: boolean }} DateRangePreset
 * @typedef {(row: unknown, value: unknown, index: number) => boolean} FilterCondition
 *
 * @typedef {{
 *   ref: string,
 *   group?: string,
 *   multiple?: boolean,
 *   condition?: FilterCondition,
 * }} FilterRuleShared
 *
 * @typedef {FilterRuleShared & (
 *   | { type: 'boolean', value: boolean, label: string }
 *   | { type: 'option', value: unknown, label: string }
 *   | { type: 'date', value: unknown, label: string }
 *   | { type: 'free' }
 *   | { type: 'children', children: readonly SelectItem[] }
 *   | { type: 'observer', children: (context: FilterLoadContext) => Promise<readonly SelectItem[]> }
 *   | {
 *       type: 'lazy',
 *       label: string,
 *       children: (context: FilterLoadContext) => Promise<readonly SelectItem[]>,
 *     }
 *   | {
 *       type: 'typeahead',
 *       label: string,
 *       children: (term: string, context: FilterLoadContext) => Promise<readonly SelectItem[]>,
 *       resolve?: (values: readonly unknown[], context: FilterLoadContext) => Promise<readonly SelectItem[]>,
 *       minChars?: number,
 *     }
 *   | { type: 'daterange', label: string, presets?: readonly DateRangePreset[] }
 * )} FilterRule
 *
 * @typedef {ComboboxOption & {
 *   ref: string,
 *   type: FilterRuleType,
 *   condition?: FilterCondition,
 *   placeholder?: boolean,
 *   loading?: boolean,
 *   preset?: boolean,
 * }} FilterOption
 *
 * @typedef {{ ref: string, type: FilterRuleType, value: unknown }} FilterCacheEntry
 *
 * @typedef {{
 *   ref: string,
 *   type: FilterRuleType,
 *   value: unknown,
 *   key: string,
 *   match: import('./filter-descriptor.js').FilterMatch,
 *   predicate?: FilterCondition,
 * }} FilterState
 */

const STATE_COMPONENT = 'ui-dynamic-filter';

/** Characters a `typeahead` rule wants before it will ask the server. */
const TYPEAHEAD_MIN_CHARS = 2;

/**
 * Quiet period after the last keystroke before typeahead searches go out.
 *
 * Not exported. It was, for one caller: the async suite added twenty to it and
 * slept, because a raw `setTimeout` gave it no other way to reach the far side of
 * the debounce. The debounce now goes through the injected clock, so the suite
 * drains that instead and this number is nobody's business but this file's.
 * ADR-0079.
 */
const TYPEAHEAD_DEBOUNCE_MS = 300;

/**
 * One control holding every filter a screen offers, and the rail of chips saying
 * which are on.
 *
 * A rule declares a filter; the component turns rules into options, remembers what
 * was chosen across reloads, and emits state. What it emits is a filter
 * descriptor — `key`, `match` and `predicate` from `filter-descriptor.js`, which
 * this element and `ui-table` both import and neither owns — so connecting the two
 * is one assignment and they never import each other.
 *
 * `condition` is optional: leaving it out means "match the column named `ref`, the
 * way this rule type matches", and the rule type decides the comparison. A rule
 * writes a predicate only when its comparison is neither a field comparison nor a
 * range.
 *
 * Text is never shipped. Group names, option labels and rule captions arrive from
 * the consumer already translated; what the filter says about itself is standard
 * text from `ui.filter.*` through `text.js`. The combobox and the range editor
 * resolve their own, so this element forwards no labels to either.
 */
export class UiDynamicFilter extends SignalElement {
  static properties = {
    name: { type: String },
    rules: { attribute: false },
    options: { state: true },
    selection: { state: true },
    rangeEditor: { state: true },
    loading: { type: Boolean, reflect: true },
    disabled: { type: Boolean, reflect: true },
    persist: { type: Boolean },
    label: { type: String },
    placeholder: { type: String },
    locale: { type: String },
    comboboxClass: { type: String, attribute: 'combobox-class' },
  };

  /** Identity under which the chosen filters are persisted. Required. */
  name = '';

  /** @type {readonly FilterRule[]} */
  rules = [];

  /** @type {readonly FilterOption[]} */
  options = [];

  /** @type {readonly FilterOption[]} */
  selection = [];

  /**
   * The `daterange` ref whose row is currently showing its editor, or empty.
   * One at a time, because two open range forms in one dropdown is noise.
   */
  rangeEditor = '';

  loading = false;
  disabled = false;

  /** Off turns the component stateless, which is what a modal filter wants. */
  persist = true;

  label = '';
  placeholder = '';

  /** BCP-47 tag for date formatting. Empty follows the browser. */
  locale = '';

  comboboxClass = '';

  /** @type {readonly FilterRule[] | undefined} */
  #builtRules;

  /** @type {readonly FilterCacheEntry[]} */
  #cache = [];

  /**
   * Options fetched once and kept: an `observer` rule's list, a `lazy` rule's
   * list after it was asked for, a `typeahead` rule's labels for values restored
   * from storage.
   *
   * @type {Map<string, readonly SelectItem[]>}
   */
  #loaded = new Map();

  /**
   * The current typeahead results per ref, replaced wholesale by each search.
   *
   * Wholesale replacement is what removes the "which options belong to the search
   * that is showing" bookkeeping: this map *is* the current result, and a selected
   * option keeps its own object in `selection`, so nothing has to stay in the list
   * to make its chip render.
   *
   * @type {Map<string, readonly SelectItem[]>}
   */
  #results = new Map();

  /**
   * The custom range currently held per `daterange` ref. Kept beside the options
   * rather than on them, so a rebuild — a lazy load elsewhere, a typeahead
   * search — cannot lose a range the user has already picked.
   *
   * @type {Map<string, string>}
   */
  #ranges = new Map();

  #buildToken = 0;

  #searchToken = 0;

  /**
   * The call that cancels a scheduled search, while one is scheduled. From the
   * injected clock, not `setTimeout`. ADR-0079.
   *
   * @type {(() => void) | undefined}
   */
  #cancelSearch;

  /** @type {AbortController | undefined} */
  #loadController;

  /** @type {AbortController | undefined} */
  #searchController;

  /**
   * Rules are compiled here rather than in `connectedCallback` because a late
   * `.rules` assignment is the normal case: a page builds its rules from a
   * service response, after its own first render.
   *
   * The identity check, rather than Lit's `changedProperties`, is deliberate.
   * The first update reports `rules` as changed from `undefined` — the base
   * class's field adoption is what wrote it — so a `changedProperties` guard
   * cannot tell "constructed with rules" from "given rules a tick later", and
   * the second is the case that matters.
   */
  willUpdate() {
    if (this.rules === this.#builtRules) return;
    this.#build();
  }

  onDestroy() {
    this.#cancelSearch?.();
    this.#cancelSearch = undefined;
    this.#loadController?.abort();
    this.#searchController?.abort();
  }

  /**
   * Standard interaction text, from `ui.filter.*`. See `text.js`. The four names
   * here are the ones this element says itself; the combobox it renders and the
   * range editor it expands resolve their own, which is why neither is handed a
   * label any more.
   *
   * @param {string} name
   * @returns {string}
   */
  text(name) {
    return standardText('filter', name);
  }

  /**
   * Rebuild options and selection from persisted state, discarding what is
   * chosen now. For applying a filter preset saved elsewhere without recreating
   * the element.
   */
  reload() {
    this.selection = [];
    this.#loaded.clear();
    this.#results.clear();
    this.#ranges.clear();
    this.#build();
  }

  #build() {
    this.#builtRules = this.rules;
    const token = (this.#buildToken += 1);
    this.#loadController?.abort();
    const controller = new AbortController();
    this.#loadController = controller;

    this.#cache = this.#loadCache();
    const jobs = this.#initialJobs(controller.signal);
    // Set before the first restore, because a restore that runs while a rule is
    // still loading must not conclude the rule's persisted value is stale.
    this.loading = jobs.length > 0;
    this.#adoptCachedRanges();
    this.options = this.#createOptions();
    this.#restoreSelection();
    if (this.#cache.length === 0) this.#applyDefaultPresets();

    void this.#loadInitial(token, jobs);
  }

  /**
   * A persisted `daterange` value belongs to the custom option unless it is one
   * of the presets — "this week" is a preset choice, "3 to 17 March" is not.
   */
  #adoptCachedRanges() {
    for (const rule of this.normalizedRules) {
      if (rule.type !== 'daterange') continue;
      const entry = this.#cache.find((candidate) => candidate.ref === rule.ref);
      if (entry === undefined || typeof entry.value !== 'string') continue;
      if ((rule.presets ?? []).some((preset) => preset.value === entry.value)) continue;
      this.#ranges.set(rule.ref, entry.value);
    }
  }

  /**
   * With nothing in storage, presets marked `default` start selected.
   *
   * Deliberately not persisted. The default stands until the user touches the
   * filters, and only then does the state — default included — get written. That
   * is what lets a default of "this week" mean this week on every visit, rather
   * than the week it was first computed.
   */
  #applyDefaultPresets() {
    /** @type {FilterOption[]} */
    const defaults = [];
    for (const rule of this.normalizedRules) {
      if (rule.type !== 'daterange') continue;
      const preset = (rule.presets ?? []).find((candidate) => candidate.default === true);
      if (preset === undefined) continue;
      const option = this.options.find(
        (candidate) =>
          candidate.ref === rule.ref &&
          candidate.preset === true &&
          candidate.value === preset.value,
      );
      if (option !== undefined) defaults.push(option);
    }
    if (defaults.length === 0) return;
    this.selection = defaults;
    for (const option of defaults) this.#lockRef(option);
  }

  /**
   * Everything that must be fetched before the restored state is complete: every
   * `observer` list, the `lazy` lists a persisted value belongs to, and the
   * labels a `typeahead` needs to render a persisted value as anything other
   * than a raw id.
   *
   * A deferred rule with nothing in storage is left alone — that is the whole
   * point of deferring it — but a deferred rule *with* something in storage is
   * not optional. Its option does not exist until the list arrives, and an entry
   * whose option is missing is dropped by `#restoreSelection`, so skipping the
   * fetch does not merely delay the chip: it deletes the filter the user left
   * switched on.
   *
   * @param {AbortSignal} signal
   * @returns {{ ref: string, run: () => Promise<readonly SelectItem[]> }[]}
   */
  #initialJobs(signal) {
    /** @type {{ ref: string, run: () => Promise<readonly SelectItem[]> }[]} */
    const jobs = [];
    for (const rule of this.normalizedRules) {
      const values = this.#cache.filter((entry) => entry.ref === rule.ref).map((e) => e.value);
      if (rule.type === 'observer') {
        jobs.push({ ref: rule.ref, run: () => rule.children({ signal }) });
      } else if (rule.type === 'lazy' && values.length > 0) {
        jobs.push({ ref: rule.ref, run: () => rule.children({ signal }) });
      } else if (rule.type === 'typeahead' && values.length > 0) {
        const resolve = rule.resolve;
        jobs.push({
          ref: rule.ref,
          run:
            resolve === undefined
              ? () => this.#searchForValues(rule, values, signal)
              : () => resolve(values, { signal }),
        });
      }
    }
    return jobs;
  }

  /**
   * A persisted `typeahead` value, resolved by searching for it.
   *
   * `resolve` is the right way to do this — one request for the whole set, and
   * the server matching on id. This is the fallback for a rule that did not
   * declare one, and it works because the value a typeahead stores is usually
   * the thing the search matches on. It is not free: one request per persisted
   * value. A rule restoring more than a couple should declare `resolve`.
   *
   * @param {FilterRule & { type: 'typeahead' }} rule
   * @param {readonly unknown[]} values
   * @param {AbortSignal} signal
   * @returns {Promise<readonly SelectItem[]>}
   */
  async #searchForValues(rule, values, signal) {
    const results = await Promise.all(
      values.map((value) => settle(rule.children(String(value), { signal }))),
    );
    /** @type {SelectItem[]} */
    const found = [];
    for (const [index, items] of results.entries()) {
      const value = values[index];
      // A search for "Milano" answers with every comune containing it; only the
      // one that *is* the persisted value is the restored option.
      const match = items.find((item) => sameValue(item.value, value));
      if (match !== undefined) found.push(match);
    }
    return found;
  }

  /**
   * @param {number} token
   * @param {{ ref: string, run: () => Promise<readonly SelectItem[]> }[]} jobs
   */
  async #loadInitial(token, jobs) {
    if (jobs.length > 0) {
      const results = await Promise.all(jobs.map((job) => settle(job.run())));
      if (token !== this.#buildToken) return;
      for (const [index, items] of results.entries()) {
        const job = jobs[index];
        if (job !== undefined) this.#loaded.set(job.ref, items);
      }
      this.loading = false;
      this.options = this.#createOptions();
      this.#restoreSelection();

      // Resolved typeahead labels have now done their one job, which was to name
      // the restored chips. They are not search results, and leaving them in the
      // panel would greet a reopened dropdown with the last session's values
      // instead of the hint. The chips keep their own option objects, so nothing
      // is lost by dropping these.
      for (const rule of this.#typeaheadRules) this.#loaded.delete(rule.ref);

      // `#rebuild`, not a bare `#createOptions`: the fresh options are all
      // enabled and the selection points at the previous ones. Assigning the list
      // straight across would leave every restored filter unlocked — a second
      // value pickable for a ref that holds one — and the chips pointing at
      // objects no longer in the list.
      this.#rebuild();
    }

    // Always after a render, so a consumer that attached its listener straight
    // after creating the element still hears the first state.
    await this.updateComplete;
    if (token !== this.#buildToken) return;
    this.#emit('filter-ready');
  }

  /** @returns {readonly FilterCacheEntry[]} */
  #loadCache() {
    if (!this.persist || this.name === '') return [];
    return loadPreference(STATE_COMPONENT, this.name) ?? [];
  }

  /** @param {readonly FilterOption[]} [selection] */
  #saveCache(selection = this.selection) {
    this.#cache = selection.map((option) => ({
      ref: option.ref,
      type: option.type,
      value: option.value,
    }));
    if (!this.persist || this.name === '') return;
    savePreference(STATE_COMPONENT, this.name, this.#cache);
  }

  /**
   * Recreate the option list and re-point the selection at the fresh objects.
   *
   * Rebuilding rather than splicing is safe here only because the combobox
   * compares options by ref and value, not by identity. The original spliced,
   * and paid for it with a `findIndex` per lazy load and a scroll-position
   * workaround around the DOM churn.
   */
  #rebuild() {
    const options = this.#createOptions();
    this.selection = this.selection.map(
      (chosen) => options.find((option) => sameOption(option, chosen)) ?? chosen,
    );
    this.options = options;
    for (const chosen of this.selection) this.#lockRef(chosen);
  }

  /** @returns {FilterOption[]} */
  #createOptions() {
    /** @type {FilterOption[]} */
    const options = [];
    for (const rule of this.normalizedRules) {
      switch (rule.type) {
        case 'boolean':
        case 'option':
        case 'date': {
          options.push(this.#toOption(rule, { value: rule.value, label: rule.label }));
          break;
        }
        case 'children': {
          for (const item of rule.children) options.push(this.#toOption(rule, item));
          break;
        }
        case 'observer': {
          for (const item of this.#loaded.get(rule.ref) ?? []) {
            options.push(this.#toOption(rule, item));
          }
          break;
        }
        case 'lazy': {
          const items = this.#loaded.get(rule.ref);
          if (items === undefined) {
            options.push({
              ...this.#toOption(rule, { value: placeholderValue(rule.ref), label: rule.label }),
              placeholder: true,
              loading: false,
            });
            break;
          }
          for (const item of items) options.push(this.#toOption(rule, item));
          break;
        }
        case 'typeahead': {
          // A permanently disabled row, so the group is visible — and says what
          // to do about it — before anything has been typed.
          options.push({
            ...this.#toOption(rule, { value: placeholderValue(rule.ref), label: rule.label }),
            disabled: true,
            placeholder: true,
          });
          const items = this.#results.get(rule.ref) ?? this.#loaded.get(rule.ref) ?? [];
          for (const item of items) options.push(this.#toOption(rule, item));
          break;
        }
        case 'daterange': {
          // Presets first: a ready-made range that applies on click. Then the
          // one row that opens the dialog, carrying whatever custom range is
          // currently held.
          for (const preset of rule.presets ?? []) {
            options.push({
              ...this.#toOption(rule, { value: preset.value, label: preset.label }),
              preset: true,
            });
          }
          options.push(
            this.#toOption(rule, {
              value: this.#ranges.get(rule.ref),
              label: rule.label,
            }),
          );
          break;
        }
        case 'free': {
          // A free-text rule has no options of its own. Its option exists only
          // because something was typed, so it is restored from the cache and
          // otherwise created by `addTag`.
          for (const entry of this.#cache) {
            if (entry.ref !== rule.ref) continue;
            options.push(this.#toOption(rule, { value: entry.value, label: String(entry.value) }));
          }
          break;
        }
        default:
          break;
      }
    }
    return options;
  }

  /**
   * @param {FilterRule} rule
   * @param {SelectItem} item
   * @returns {FilterOption}
   */
  #toOption(rule, item) {
    return {
      value: item.value,
      label: item.label,
      group: item.group ?? rule.group,
      disabled: item.disabled ?? false,
      ref: rule.ref,
      type: rule.type,
      condition: rule.condition,
    };
  }

  #restoreSelection() {
    if (this.#cache.length === 0) return;
    /** @type {FilterOption[]} */
    const restored = [];
    for (const entry of this.#cache) {
      const option = this.options.find(
        (candidate) =>
          candidate.ref === entry.ref &&
          candidate.placeholder !== true &&
          sameValue(candidate.value, entry.value),
      );
      if (option !== undefined) restored.push(option);
    }
    this.selection = restored;
    for (const option of restored) this.#lockRef(option);
    // Rewrite the cache: an entry whose option no longer exists — a role that was
    // deleted, a rule the consumer removed — must not outlive this load, or it
    // reappears as an invisible filter the user cannot switch off.
    //
    // A rule still loading is the exception. Its options are not here yet, and
    // dropping the entry now would lose exactly the state this load is fetching.
    if (!this.loading) this.#saveCache();
  }

  get normalizedRules() {
    return Array.isArray(this.rules) ? /** @type {readonly FilterRule[]} */ (this.rules) : [];
  }

  /** @param {string} ref */
  #ruleFor(ref) {
    return this.normalizedRules.find((rule) => rule.ref === ref);
  }

  /**
   * One value per ref, enforced by disabling the siblings rather than hiding them:
   * a greyed "Status: active" next to the chosen "Status: pending" says why it
   * cannot be picked, where a vanished row says nothing. `multiple: true` on the
   * rule opts out.
   *
   * @param {FilterOption} chosen
   */
  #lockRef(chosen) {
    if (this.#ruleFor(chosen.ref)?.multiple === true) return;
    let touched = false;
    for (const option of this.options) {
      if (option.ref !== chosen.ref || sameValue(option.value, chosen.value)) continue;
      if (option.disabled === true) continue;
      option.disabled = true;
      touched = true;
    }
    if (touched) this.options = [...this.options];
  }

  /** @param {FilterOption} released */
  #unlockRef(released) {
    let touched = false;
    for (const option of this.options) {
      if (option.ref !== released.ref || option.disabled !== true) continue;
      // The typeahead hint is not a value and is never selectable.
      if (option.placeholder === true) continue;
      option.disabled = false;
      touched = true;
    }
    if (touched) this.options = [...this.options];
  }

  /** @param {Event} event */
  onOptionAdd(event) {
    const option = /** @type {CustomEvent<FilterOption>} */ (event).detail;
    if (option.placeholder === true) {
      // Not a value. The combobox has already put it in its own selection, and
      // the `.value` binding below undoes that on the next render.
      this.selection = this.selection.filter((candidate) => candidate !== option);
      if (option.type === 'lazy') void this.#loadLazy(option);
      return;
    }
    if (option.type === 'daterange' && option.preset !== true) {
      // Not a value yet either: it becomes one when the editor under the row says
      // so. Clicking the row again folds the editor away.
      this.selection = this.selection.filter((candidate) => candidate !== option);
      this.rangeEditor = this.rangeEditor === option.ref ? '' : option.ref;
      return;
    }
    this.selection = [...this.selection, option];
    this.#lockRef(option);
    this.#saveCache();
    this.#emit('filter-change');
  }

  /** @param {Event} event */
  onOptionRemove(event) {
    const option = /** @type {CustomEvent<FilterOption>} */ (event).detail;
    this.selection = this.selection.filter((candidate) => candidate !== option);
    if (option.type === 'free') {
      // A free entry is not a listed choice, it is something the user typed.
      // Leaving it in the list would offer it back as a suggestion.
      this.options = this.options.filter((candidate) => candidate !== option);
    } else {
      // A preset keeps its fixed range; a custom one had only the range the user
      // just discarded, so the row goes back to being an empty invitation.
      if (option.type === 'daterange' && option.preset !== true) {
        this.#ranges.delete(option.ref);
        this.options = this.#createOptions();
      }
      this.#unlockRef(option);
    }
    this.#saveCache();
    this.#emit('filter-change');
  }

  onSelectionClear() {
    this.selection = [];
    this.rangeEditor = '';
    this.#ranges.clear();
    this.options = this.#createOptions()
      .filter((option) => option.type !== 'free')
      .map((option) => {
        if (option.placeholder !== true) option.disabled = false;
        return option;
      });
    this.#saveCache([]);
    this.#emit('filter-change');
  }

  /**
   * The row whose editor is showing, as the option object the combobox compares
   * against. Reading it out of `options` rather than keeping the object is what
   * survives a rebuild: a lazy load elsewhere replaces every option, and a held
   * reference would point at a row no longer in the list.
   */
  get rangeEditorOption() {
    if (this.rangeEditor === '') return undefined;
    return this.options.find(
      (option) =>
        option.ref === this.rangeEditor && option.type === 'daterange' && option.preset !== true,
    );
  }

  /**
   * The range editor that belongs under the expanded row.
   *
   * Dismissing leaves nothing behind, which is why the row was never added to the
   * selection in the first place: the Angular version added it, opened a modal,
   * and had to unpick the selection on the cancel branch.
   *
   * @type {(option: ComboboxOption) => unknown}
   */
  optionExpansion = (option) => {
    const filterOption = /** @type {FilterOption} */ (option);
    if (filterOption.type !== 'daterange' || filterOption.preset === true) return undefined;
    return html`<ui-date-range
      auto-focus
      data-ui-part="dynamic-filter-range"
      .range=${typeof filterOption.value === 'string' ? filterOption.value : ''}
      @range-confirm=${(/** @type {CustomEvent<string>} */ event) => {
        this.#applyRange(filterOption, event.detail);
      }}
      @range-cancel=${() => {
        this.rangeEditor = '';
      }}
    ></ui-date-range>`;
  };

  /**
   * @param {FilterOption} option
   * @param {string} range
   */
  #applyRange(option, range) {
    this.rangeEditor = '';
    if (range === '') return;

    // Picking, by hand, the days a preset already covers selects the preset.
    // Otherwise the same range would sit in two rows at once, and only one of
    // them would be the chip — which is also how a restored value is read, in
    // `#adoptCachedRanges`.
    const rule = this.#ruleFor(option.ref);
    const matchesPreset =
      rule?.type === 'daterange' && (rule.presets ?? []).some((preset) => preset.value === range);
    if (!matchesPreset) this.#ranges.set(option.ref, range);
    this.options = this.#createOptions();
    const chosen = this.options.find(
      (candidate) => candidate.ref === option.ref && candidate.value === range,
    );
    if (chosen === undefined) return;
    this.selection = [...this.selection, chosen];
    this.#lockRef(chosen);
    this.#saveCache();
    this.#emit('filter-change');
  }

  /**
   * The panel is closing, so the current typeahead results stop being relevant.
   * Dropping them means a reopened panel shows the hint again rather than the
   * leftovers of a search from five minutes ago. A half-filled range editor goes
   * with them, for the same reason.
   */
  onPanelClose() {
    this.#cancelSearch?.();
    this.#cancelSearch = undefined;
    // Cancelling the pending debounce is not enough: a search already in flight
    // would land after this and put its results straight back, so a reopened panel
    // would show the leftovers this method exists to drop. Bumping the token is
    // what makes the in-flight `#runSearch` discard its own reply.
    this.#searchToken += 1;
    if (this.#searchController !== undefined) {
      this.#searchController.abort();
      this.#searchController = undefined;
      // The discarded reply will not reach the line that clears this.
      this.loading = false;
    }
    this.rangeEditor = '';
    if (this.#results.size === 0) return;
    this.#results.clear();
    this.#rebuild();
  }

  /**
   * One debounced pipeline for every typeahead rule at once, and one abort per
   * keystroke so an overtaken search cannot land after the search that replaced
   * it. That is `switchMap` plus `debounceTime` plus `forkJoin`, without RxJS.
   *
   * @param {Event} event
   */
  onSearch(event) {
    const term = /** @type {CustomEvent<string>} */ (event).detail;
    if (this.#typeaheadRules.length === 0) return;
    this.#cancelSearch?.();
    this.#cancelSearch = schedule(() => {
      this.#cancelSearch = undefined;
      void this.#runSearch(term);
    }, TYPEAHEAD_DEBOUNCE_MS);
  }

  get #typeaheadRules() {
    return this.normalizedRules.filter((rule) => rule.type === 'typeahead');
  }

  /** @param {string} term */
  async #runSearch(term) {
    const token = (this.#searchToken += 1);
    this.#searchController?.abort();

    const rules = this.#typeaheadRules.filter(
      (rule) => term.length >= (rule.minChars ?? TYPEAHEAD_MIN_CHARS),
    );
    if (rules.length === 0) {
      // Too short, or cleared: back to just the hint.
      if (this.#results.size === 0) return;
      this.#results.clear();
      this.#rebuild();
      return;
    }

    const controller = new AbortController();
    this.#searchController = controller;
    this.loading = true;
    const results = await Promise.all(
      rules.map((rule) => settle(rule.children(term, { signal: controller.signal }))),
    );
    if (token !== this.#searchToken) return;

    this.#searchController = undefined;
    this.loading = false;
    for (const [index, items] of results.entries()) {
      const rule = rules[index];
      if (rule !== undefined) this.#results.set(rule.ref, items);
    }
    this.#rebuild();
  }

  /**
   * A lazy list, fetched the first time its row is expanded.
   *
   * The signal is the current build's, not the element's lifetime. A new `.rules`
   * assignment throws away every option this load was going to fill in, so the
   * request is dead the moment the rebuild starts — and using `this.lifetime` meant
   * only disconnection could cancel it, leaving the reply to be written into a
   * `#loaded` map that no longer describes the rules on screen.
   *
   * @param {FilterOption} placeholder
   */
  async #loadLazy(placeholder) {
    const rule = this.#ruleFor(placeholder.ref);
    if (rule?.type !== 'lazy' || placeholder.loading === true) return;

    const token = this.#buildToken;
    const signal = this.#loadController?.signal ?? this.lifetime;
    placeholder.loading = true;
    this.options = [...this.options];
    try {
      const items = await rule.children({ signal });
      if (token !== this.#buildToken) return;
      this.#loaded.set(rule.ref, items);
      this.#rebuild();
    } catch {
      if (token !== this.#buildToken) return;
      // Leave the row in place and selectable again: a failed load is worth a
      // second try, and a row that silently stops responding is not.
      placeholder.loading = false;
      this.options = [...this.options];
    }
  }

  /**
   * Typed text becomes an option belonging to the free rule. One at a time: the
   * second free entry would be a second value for the same ref, and refs hold
   * one value.
   *
   * @type {(term: string) => FilterOption | undefined}
   */
  addTag = (term) => {
    const rule = this.normalizedRules.find((candidate) => candidate.type === 'free');
    if (rule === undefined) return undefined;
    if (this.selection.some((option) => option.type === 'free')) return undefined;
    const option = this.#toOption(rule, { value: term, label: term });
    this.options = [...this.options, option];
    return option;
  };

  /** Hides the add-tag row once a free entry exists, without touching the rule set. */
  get addTagFn() {
    if (!this.normalizedRules.some((rule) => rule.type === 'free')) return undefined;
    if (this.selection.some((option) => option.type === 'free')) return undefined;
    return this.addTag;
  }

  /**
   * Two rows escape the combobox's own label matching.
   *
   * A typeahead result was matched by the server, quite possibly on a field the
   * label does not show — a comune matched by postcode. Filtering it again here
   * would hide the very row the user searched for.
   *
   * A typeahead hint is the opposite: it is only useful until the search takes
   * over, so it survives exactly as long as the term is too short to search.
   *
   * @type {(term: string, option: ComboboxOption) => boolean}
   */
  optionSearch = (term, option) => {
    const filterOption = /** @type {FilterOption} */ (option);
    if (filterOption.type === 'typeahead') {
      if (filterOption.placeholder !== true) return true;
      const rule = this.#ruleFor(filterOption.ref);
      const minChars =
        rule?.type === 'typeahead' ? (rule.minChars ?? TYPEAHEAD_MIN_CHARS) : TYPEAHEAD_MIN_CHARS;
      return term.length < minChars;
    }
    // The same "contains" the table applies to a `free` rule, from the module that
    // defines it. A filter whose panel matched differently from its results would
    // be a filter that hides the row it just offered.
    return compareValue(option.label, term, 'contains');
  };

  /**
   * Chips read "Group: value", because a bare "active" in a rail of six filters
   * does not say which field it belongs to.
   *
   * @type {(option: ComboboxOption) => unknown}
   */
  chipRenderer = (option) => {
    const filterOption = /** @type {FilterOption} */ (option);
    const chipText = this.#optionText(filterOption);
    const prefix = filterOption.group ?? (filterOption.type === 'free' ? this.text('free') : '');
    if (prefix === '' || prefix === undefined) return chipText;
    return html`<b>${prefix}</b>: ${chipText}`;
  };

  /**
   * A range option reads as its name followed by the days it covers, so "This
   * week" in the rail still says which week.
   *
   * @param {FilterOption} option
   */
  #optionText(option) {
    if (option.type !== 'daterange') return option.label;
    const formatted = this.#formatRange(option.value);
    return formatted === '' ? option.label : `${option.label} ${formatted}`;
  }

  /** @param {unknown} value */
  #formatRange(value) {
    const range = readRange(value);
    if (range === undefined) return '';
    const since = this.#formatDay(range.since);
    if (range.singleDay) return since;
    const until = this.#formatDay(range.until);
    // Both words empty is a deliberate configuration, not a missing message:
    // `ui.filter.from` set to "" is how a bundle asks for `3/3 – 3/7`.
    const from = this.text('from');
    const to = this.text('to');
    if (from === '' && to === '') return `${since} – ${until}`;
    return `${from} ${since} ${to} ${until}`.trim();
  }

  /** @param {string} day */
  #formatDay(day) {
    const [year, month, date] = day.split('-').map(Number);
    if (year === undefined || month === undefined || date === undefined) return day;
    return new Intl.DateTimeFormat(this.locale === '' ? undefined : this.locale, {
      dateStyle: 'short',
    }).format(new Date(year, month - 1, date));
  }

  /**
   * A row that loads rather than filters says so while it does, with a spinner
   * beside its own label rather than by replacing it: the label is what the user
   * clicked, and swapping it for "Loading…" makes the row look like it moved.
   *
   * @type {(option: ComboboxOption) => unknown}
   */
  optionRenderer = (option) => {
    const filterOption = /** @type {FilterOption} */ (option);
    if (filterOption.placeholder !== true) return this.#optionText(filterOption);
    const busy = filterOption.loading === true;
    return html`<span
      data-ui-part="dynamic-filter-hint"
      class="flex items-center gap-2"
      aria-busy=${String(busy)}
      aria-label=${busy ? `${this.text('loading')} ${filterOption.label}`.trim() : nothing}
      >${busy
        ? html`<span data-ui-part="spinner" aria-hidden="true"></span>`
        : nothing}<span>${filterOption.label}</span></span
    >`;
  };

  /**
   * What the screen hands to whatever consumes filters.
   *
   * `key` mirrors `ref`, and `match` comes from the rule type rather than from the
   * screen: a listed choice carries the value the field holds, so picking one means
   * `equals` — substring matching there is why choosing *Sales* would also select
   * *Pre-Sales* — and a range means a range.
   *
   * @returns {FilterState[]}
   */
  get states() {
    return this.selection.map((option) => ({
      ref: option.ref,
      type: option.type,
      value: option.value,
      key: option.ref,
      match: matchForRuleType(option.type),
      predicate: option.condition,
    }));
  }

  get labelAttr() {
    return optionalAttr(this.label);
  }

  /**
   * Options are compared by what they mean, not by identity, so a rebuilt list
   * still knows which of its rows are the chosen ones.
   *
   * @type {(left: ComboboxOption, right: ComboboxOption) => boolean}
   */
  compareOptions = (left, right) =>
    sameOption(/** @type {FilterOption} */ (left), /** @type {FilterOption} */ (right));

  /** @param {'filter-ready' | 'filter-change'} name */
  #emit(name) {
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, detail: this.states }));
  }
}

/** @param {string} ref */
function placeholderValue(ref) {
  return `__ui-dynamic-filter-placeholder__${ref}`;
}

/** @param {FilterOption} left @param {FilterOption} right */
function sameOption(left, right) {
  return left.ref === right.ref && sameValue(left.value, right.value);
}

/**
 * Cached values arrive from JSON, so a `Date` saved as a string will not be
 * `Object.is` its original. Comparing the JSON form keeps restore working for
 * the structured values a `date` or `daterange` rule holds.
 *
 * @param {unknown} left @param {unknown} right
 */
function sameValue(left, right) {
  if (Object.is(left, right)) return true;
  if (left === null || right === null) return false;
  if (typeof left === 'object' || typeof right === 'object') {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return false;
}

/**
 * A failed rule must not take the other rules' options down with it. One dead
 * dropdown is a bad afternoon; an empty filter bar is an unusable page.
 *
 * @param {Promise<readonly SelectItem[]>} promise
 * @returns {Promise<readonly SelectItem[]>}
 */
async function settle(promise) {
  try {
    return await promise;
  } catch {
    return [];
  }
}

// `<ui-combobox>` is in this component's template; `<ui-date-range>` is in the
// dialog it builds in JavaScript. Both are the same kind of dependency, and both
// are now one list rather than two side-effect imports.
await defineComponent({
  tag: 'ui-dynamic-filter',
  element: UiDynamicFilter,
  module: import.meta.url,
  uses: [UiCombobox, UiDateRange],
});
