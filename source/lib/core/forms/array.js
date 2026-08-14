import { computed, signal } from '@core/foundation/reactive.js';

/** @import { FormNode, FormRow, PartialValueOf, ValueOf } from '@core/forms/types.js' */
/** @import { ReadonlySignal, Signal } from '@core/foundation/types.js' */

/**
 * A repeating row: the same control built as many times as the data needs.
 *
 * A non-goal until a screen needed one, which was the recorded trigger. ADR-0009.
 * A customer's contacts are the screen: three fields per row, any number of rows,
 * each row's rules the same and each row's errors its own. What a screen
 * hand-rolls for that is a plain array in a signal plus five things it has to get
 * right — a stable key per row so a keyed `*for` does not re-render the lot, an
 * address per field so a 422 naming the second contact's email lands under the
 * second contact's email, a dirty flag that notices a row was *added* and not only
 * edited, a reset that puts the removed rows back, and a disabled state that
 * reaches rows built after the form was switched off.
 *
 * WHAT A ROW IS
 *
 * Anything satisfying `FormNode`, which in practice is a `FormGroup` for a row
 * of fields and a `FormField` for a row of one value. The array never looks
 * inside: it builds rows with the factory it was given, asks them the contract's
 * questions and prefixes their answers with an index.
 *
 * DIRTY IS STRUCTURAL, NOT ONLY CONTENT
 *
 * The rows answer for their own values; only the array can answer whether the
 * *shape* changed. The baseline is the list of row keys rather than the row count,
 * because remove-one-add-one is the case a count gets wrong. ADR-0009.
 *
 * A ROW ADDED AFTER A SUBMIT STARTS QUIET
 *
 * `markSubmitted` makes every existing row's errors visible. A row created
 * afterwards does not inherit that, because three red messages under a row the
 * user just asked for is the greeting the timing rule in `FormField` exists to
 * prevent. The next submit marks it like everything else.
 *
 * @template {FormNode} C
 * @implements {FormNode}
 */
export class FormArray {
  /**
   * The form has been submitted. Written by a parent group, read by nothing
   * here: it is the rows that show errors, and they carry their own.
   */
  submitted = signal(false);

  /**
   * The rows, with a stable key and a current index each. What a template
   * repeats over:
   *
   *     <div *for="row of form.fields.contacts.rows; key: row.key">
   *
   * @type {ReadonlySignal<readonly FormRow<C>[]>}
   */
  rows;

  /** @type {ReadonlySignal<number>} */
  length;

  /** @type {ReadonlySignal<boolean>} */
  valid;

  /** @type {ReadonlySignal<boolean>} */
  dirty;

  /**
   * Every row is off, by this array's own switch or by a container's.
   *
   * @type {ReadonlySignal<boolean>}
   */
  disabled;

  /** @type {ReadonlySignal<string | null>} */
  invalidPath;

  /** @type {() => C} */
  #create;

  /**
   * The rows as stored: key and control, without the index. The index is a
   * function of position and would be stale the moment a row above it went, so
   * it is computed in `rows` rather than kept.
   *
   * @type {Signal<readonly { key: string, control: C }[]>}
   */
  #entries = signal(/** @type {readonly { key: string, control: C }[]} */ ([]));

  /** The key list `dirty` compares against. @type {Signal<readonly string[]>} */
  #baselineKeys = signal(/** @type {readonly string[]} */ ([]));

  /** What `reset()` with no argument rebuilds. @type {readonly unknown[]} */
  #baselineValues = [];

  /** Monotonic, never reused, and scoped to this array. */
  #nextKey = 0;

  #ownDisabled = signal(false);

  /** @type {Signal<ReadonlySignal<boolean> | null>} */
  #inheritedDisabled = signal(null);

  /**
   * @param {() => C} create Builds one empty row. Called once per row, so it
   *   must return a fresh control rather than a shared one.
   * @param {readonly PartialValueOf<C>[]} [initial] The rows to start with,
   *   already clean: a form that opens on two contacts is not a form with two
   *   unsaved changes in it.
   */
  constructor(create, initial = []) {
    this.#create = create;

    // Before any row is built: `#build` hands this signal to each row, and a
    // row built against `undefined` would never hear the form being switched
    // off.
    this.disabled = computed(() => this.#ownDisabled.value || (this.#inheritedDisabled.value?.value ?? false));

    this.rows = computed(() => this.#entries.value.map((entry, index) => ({ ...entry, index })));
    this.length = computed(() => this.#entries.value.length);
    this.valid = computed(() => this.#entries.value.every((entry) => entry.control.valid.value));

    this.dirty = computed(() => {
      if (!sameKeys(this.#entries.value, this.#baselineKeys.value)) return true;
      return this.#entries.value.some((entry) => entry.control.dirty.value);
    });

    this.invalidPath = computed(() => {
      for (const [index, entry] of this.#entries.value.entries()) {
        const below = entry.control.invalidPath.value;
        if (below !== null) return prefix(index, below);
      }
      return null;
    });

    this.reset(initial);
  }

  /* ── Reading ────────────────────────────────────────────────────────────── */

  /**
   * Every row's value, in order.
   *
   * A getter rather than a signal, for the reason `FormGroup.values` is one: a
   * caller wants this at submit time, and a computed would subscribe every
   * reader to every keystroke in every row.
   *
   * @returns {ValueOf<C>[]}
   */
  get values() {
    return this.#entries.value.map((entry) => /** @type {ValueOf<C>} */ (entry.control.snapshot));
  }

  /* ── Changing the shape ─────────────────────────────────────────────────── */

  /**
   * Add a row and return it.
   *
   * @param {PartialValueOf<C>} [value] Filled in after the row is built, so the
   *   row counts as an edit — which it is, since the user asked for it.
   * @returns {C}
   */
  push(value) {
    const entry = this.#build();
    if (value !== undefined) entry.control.fill(value);
    this.#entries.value = [...this.#entries.value, entry];
    return entry.control;
  }

  /**
   * @param {number} index
   * @returns {boolean} False when there is no row there, so a double-click on a
   *   remove control cannot silently take the row below with it.
   */
  removeAt(index) {
    const entries = this.#entries.value;
    if (!Number.isInteger(index) || index < 0 || index >= entries.length) return false;
    this.#entries.value = entries.filter((_unused, at) => at !== index);
    return true;
  }

  /** Every row goes. The baseline does not, so this is an edit like any other. */
  clear() {
    this.#entries.value = [];
  }

  /* ── Values ─────────────────────────────────────────────────────────────── */

  /**
   * Set the rows to these values without moving the baseline.
   *
   * The length is part of the value: patching three rows onto two adds one and
   * patching one onto two removes one, so `array.fill(array.values)` is the
   * no-op it reads as. That is `patchValue` diverging from Angular, where extra
   * entries are ignored and the caller is left to reconcile the length itself —
   * which is the loop this class exists to stop screens from writing.
   *
   * @param {readonly PartialValueOf<C>[]} values
   */
  patch(values) {
    const entries = this.#resize(values.length);
    for (const [index, entry] of entries.entries()) {
      const value = values[index];
      if (value !== undefined) entry.control.fill(value);
    }
  }

  /**
   * Back to a clean state at these values, or at the ones this array was last
   * clean at. The baseline moves with it, keys included, so a form reset to what
   * the server returned is not dirty however many rows came and went.
   *
   * @param {readonly PartialValueOf<C>[]} [values]
   */
  reset(values) {
    const next = values ?? /** @type {readonly PartialValueOf<C>[]} */ (this.#baselineValues);
    this.submitted.value = false;
    const entries = this.#resize(next.length);
    for (const [index, entry] of entries.entries()) entry.control.reset(next[index]);
    this.#baselineKeys.value = entries.map((entry) => entry.key);
    this.#baselineValues = entries.map((entry) => entry.control.snapshot);
  }

  /* ── Disabled ───────────────────────────────────────────────────────────── */

  /**
   * Switch every row off, or back on. A row disabled on its own stays disabled;
   * see `FormField.setDisabled` for why the two sources do not collapse.
   *
   * @param {boolean} next
   */
  setDisabled(next) {
    this.#ownDisabled.value = next;
  }

  /* ── The FormNode contract ──────────────────────────────────────────────── */

  /** @returns {ValueOf<C>[]} */
  get snapshot() {
    return this.values;
  }

  /** @returns {string | null} */
  get serverErrorPath() {
    for (const [index, entry] of this.#entries.value.entries()) {
      const below = entry.control.serverErrorPath;
      if (below !== null) return prefix(index, below);
    }
    return null;
  }

  /** @param {unknown} value */
  fill(value) {
    this.patch(/** @type {readonly PartialValueOf<C>[]} */ (value));
  }

  /** @returns {boolean} */
  markSubmitted() {
    this.submitted.value = true;
    // Every row, not until the first invalid one: a submit makes the whole form
    // say what is wrong with it at once.
    for (const entry of this.#entries.value) entry.control.markSubmitted();
    return this.valid.value;
  }

  clearServerErrors() {
    for (const entry of this.#entries.value) entry.control.clearServerErrors();
  }

  /** @param {ReadonlySignal<boolean>} source */
  inheritDisabled(source) {
    this.#inheritedDisabled.value = source;
  }

  /**
   * @param {readonly string[]} path
   * @returns {FormNode | null}
   */
  leafAt(path) {
    if (path.length === 0) return this;
    const [head, ...rest] = path;
    const index = Number(head);
    // `String(index) !== head` is the check that matters: `Number('01')` and
    // `Number(' 1')` are both 1, and a server that addressed `contacts.01.email`
    // is addressing something this form cannot confirm it means.
    if (head === undefined || !Number.isInteger(index) || String(index) !== head) return null;
    return this.#entries.value[index]?.control.leafAt(rest) ?? null;
  }

  /**
   * @param {string} _code
   * @returns {boolean} Always false: an array is not a control, so a code naming
   *   one is reported to the screen as unmatched rather than shown under a row
   *   that did not cause it.
   */
  setServerError(_code) {
    return false;
  }

  /* ── Internals ──────────────────────────────────────────────────────────── */

  /**
   * The rows at this length, published, reusing the ones that survive.
   *
   * Reuse is what keeps a reset from re-rendering rows whose values did not
   * change: same key, same control, so a keyed `*for` leaves the DOM and the
   * focus alone. A length that already matches publishes nothing at all —
   * writing an equal-but-new array would notify every reader that the shape
   * changed when only the values are about to.
   *
   * @param {number} length
   * @returns {readonly { key: string, control: C }[]}
   */
  #resize(length) {
    const current = this.#entries.value;
    if (current.length === length) return current;
    const entries = [...current];
    while (entries.length > length) entries.pop();
    while (entries.length < length) entries.push(this.#build());
    this.#entries.value = entries;
    return entries;
  }

  /** @returns {{ key: string, control: C }} */
  #build() {
    const control = this.#create();
    control.inheritDisabled(this.disabled);
    this.#nextKey += 1;
    return { key: `r${this.#nextKey}`, control };
  }
}

/**
 * Rows that repeat.
 *
 *     const form = group({
 *       name: field('', [required()]),
 *       contacts: fieldArray(() => group({
 *         name: field('', [required()]),
 *         email: field('', [required(), email()]),
 *       })),
 *     });
 *
 *     form.fields.contacts.push();          // an empty row
 *     form.fields.contacts.removeAt(0);
 *     form.values;                          // { name: '…', contacts: [{ name: '…', email: '…' }] }
 *
 * @template {FormNode} C
 * @param {() => C} create
 * @param {readonly PartialValueOf<C>[]} [initial]
 * @returns {FormArray<C>}
 */
export function fieldArray(create, initial) {
  return new FormArray(create, initial);
}

/**
 * @param {number} index
 * @param {string} below Empty when the row itself is the answer.
 * @returns {string}
 */
function prefix(index, below) {
  return below === '' ? String(index) : `${index}.${below}`;
}

/**
 * @param {readonly { key: string }[]} entries
 * @param {readonly string[]} keys
 * @returns {boolean}
 */
function sameKeys(entries, keys) {
  return entries.length === keys.length && entries.every((entry, index) => entry.key === keys[index]);
}
