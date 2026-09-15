import { computed, signal } from '@core/foundation/reactive.js';

import { whenSettled } from '@core/forms/settled.js';

/** @import { FormNode, FormRow, PartialValueOf, Validator, ValueOf } from '@core/forms/types.js' */
/** @import { ReadonlySignal, Signal } from '@core/foundation/types.js' */

/**
 * A repeating row of controls, such as a customer's contacts, built once per item.
 *
 * The array handles what a hand-rolled list gets wrong. It gives each row a stable
 * key for keyed `*for`, an address per field so a 422 lands on the right row, a dirty
 * flag that notices added rows, a reset that restores removed rows and a disabled
 * state that reaches rows built later.
 *
 * A row is any `FormNode`, usually a `FormGroup`, or a `FormField` for a single value.
 * The array builds rows with its factory and prefixes their answers with an index.
 *
 * Dirty covers shape as well as content. The baseline is the list of row keys, so
 * removing one row and adding another still counts as a change.
 *
 * The third argument lists validators over all row values, such as `minRows(1)`.
 * Their code belongs to the array, and a `ui-form-error` bound to the array shows it.
 * A code for one row goes through `applyErrors({ 'contacts.1.email': 'duplicated' })`
 * instead. An empty array counts as untouched, so "at least one contact" waits for a
 * submit.
 *
 * A row added after a submit starts quiet. The next submit marks it like the others.
 *
 * @template {FormNode} C
 * @implements {FormNode}
 */
export class FormArray {
  /**
   * True once the form was submitted. A parent group writes it. Rows carry their own
   * flag and show the errors.
   */
  submitted = signal(false);

  /**
   * The rows, each with a stable key and its current index. Templates repeat over
   * this.
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
   * True when this array or a container disabled every row.
   *
   * @type {ReadonlySignal<boolean>}
   */
  disabled;

  /** @type {ReadonlySignal<string | null>} */
  invalidPath;

  /**
   * True when every row has been visited and there is at least one.
   *
   * @type {ReadonlySignal<boolean>}
   */
  touched;

  /** @type {ReadonlySignal<boolean>} */
  pending;

  /**
   * This array's own code, ignoring its rows. Empty while disabled.
   *
   * @type {ReadonlySignal<string>}
   */
  error;

  /**
   * The array's own code once it may show, after a submit or once every row was
   * visited.
   *
   * @type {ReadonlySignal<string>}
   */
  visibleError;

  /** @type {() => C} */
  #create;

  /**
   * The stored rows, key and control. The index is derived in `rows`, since it changes
   * whenever a row above moves.
   *
   * @type {Signal<readonly { key: string, control: C }[]>}
   */
  #entries = signal(/** @type {readonly { key: string, control: C }[]} */ ([]));

  /** The key list `dirty` compares against. @type {Signal<readonly string[]>} */
  #baselineKeys = signal(/** @type {readonly string[]} */ ([]));

  /** What `reset()` with no argument rebuilds. @type {readonly unknown[]} */
  #baselineValues = [];

  /** Increases per row and is never reused within this array. */
  #nextKey = 0;

  #ownDisabled = signal(false);

  /** @type {Signal<ReadonlySignal<boolean> | null>} */
  #inheritedDisabled = signal(null);

  /**
   * @param {() => C} create Builds one empty row. Called once per row, so it must
   *   return a fresh control.
   * @param {readonly PartialValueOf<C>[]} [initial] The starting rows, already clean,
   *   so a form opening on two contacts has no unsaved changes.
   * @param {readonly Validator<ValueOf<C>[]>[]} [validators] Rules over the whole
   *   list, run in order. The first failure wins.
   */
  constructor(create, initial = [], validators = []) {
    this.#create = create;

    // Create `disabled` before any row, because `#build` hands it to each row.
    this.disabled = computed(() => this.#ownDisabled.value || (this.#inheritedDisabled.value?.value ?? false));

    this.rows = computed(() => this.#entries.value.map((entry, index) => ({ ...entry, index })));
    this.length = computed(() => this.#entries.value.length);

    // Without rules, `own` is a constant, as in `FormGroup`.
    const own =
      validators.length === 0
        ? computed(() => '')
        : computed(() => {
            const values = this.values;
            for (const validate of validators) {
              const code = validate(values);
              if (code !== '') return code;
            }
            return '';
          });

    this.valid = computed(
      () =>
        this.#entries.value.every((entry) => entry.control.valid.value) && (this.disabled.value || own.value === ''),
    );
    this.pending = computed(() => this.#entries.value.some((entry) => entry.control.pending.value));

    this.touched = computed(
      () =>
        this.#entries.value.length > 0 &&
        this.#entries.value.every((entry) => entry.control.disabled.value || entry.control.touched.value),
    );

    this.error = computed(() => (this.disabled.value ? '' : own.value));
    this.visibleError = computed(() => {
      if (this.error.value === '') return '';
      return this.submitted.value || this.touched.value ? this.error.value : '';
    });

    this.dirty = computed(() => {
      if (!sameKeys(this.#entries.value, this.#baselineKeys.value)) return true;
      return this.#entries.value.some((entry) => entry.control.dirty.value);
    });

    this.invalidPath = computed(() => {
      for (const [index, entry] of this.#entries.value.entries()) {
        const below = entry.control.invalidPath.value;
        if (below !== null) return prefix(index, below);
      }
      // `''` means the array itself, for a rule about the list.
      return this.disabled.value || own.value === '' ? null : '';
    });

    this.reset(initial);
  }

  /* ── Reading ────────────────────────────────────────────────────────────── */

  /**
   * Every row's value, in order. A getter for the same reason as `FormGroup.values`.
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
   * @param {PartialValueOf<C>} [value] Filled in after the row is built, so the new
   *   row counts as an edit.
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
   * @returns {boolean} False when no row exists at `index`, so a double-click can't
   *   remove the next row too.
   */
  removeAt(index) {
    const entries = this.#entries.value;
    if (!Number.isInteger(index) || index < 0 || index >= entries.length) return false;
    this.#entries.value = entries.filter((_unused, at) => at !== index);
    return true;
  }

  /** Remove every row. The baseline stays, so this counts as an edit. */
  clear() {
    this.#entries.value = [];
  }

  /* ── Values ─────────────────────────────────────────────────────────────── */

  /**
   * Set the rows to these values without moving the baseline.
   *
   * The length is part of the value, so patching three rows onto two adds one, and
   * `array.fill(array.values)` changes nothing. Angular ignores extra entries instead.
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
   * Return to a clean state at these values, or at the last clean values. The baseline
   * moves, keys included, so a form reset to the server's response isn't dirty.
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
   * Disable or enable every row. A row disabled on its own stays disabled.
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
    // Mark every row, so the whole form shows its errors at once.
    for (const entry of this.#entries.value) entry.control.markSubmitted();
    return this.valid.value;
  }

  clearServerErrors() {
    for (const entry of this.#entries.value) entry.control.clearServerErrors();
  }

  /**
   * Resolve once no asynchronous check in any row is waiting or in flight.
   *
   * @returns {Promise<void>}
   */
  whenSettled() {
    return whenSettled(this.pending);
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
    // `String(index) !== head` rejects `01` and ` 1`, which `Number` would accept.
    if (head === undefined || !Number.isInteger(index) || String(index) !== head) return null;
    return this.#entries.value[index]?.control.leafAt(rest) ?? null;
  }

  /**
   * @param {string} _code
   * @returns {boolean} Always false. An array isn't a control, so a code naming it
   *   comes back unmatched.
   */
  setServerError(_code) {
    return false;
  }

  /* ── Internals ──────────────────────────────────────────────────────────── */

  /**
   * Resize the rows, reusing survivors, and publish. Reused rows keep their key and
   * control, so a keyed `*for` leaves their DOM and focus alone. An unchanged length
   * publishes nothing.
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
 * Create a field array.
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
 * @param {readonly Validator<ValueOf<C>[]>[]} [validators]
 * @returns {FormArray<C>}
 */
export function fieldArray(create, initial, validators) {
  return new FormArray(create, initial, validators);
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
