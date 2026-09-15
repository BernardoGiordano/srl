import { computed, signal } from '@core/foundation/reactive.js';

import { whenSettled } from '@core/forms/settled.js';

/** @import { FormNode, PartialValueOf, Validator, ValueOf } from '@core/forms/types.js' */
/** @import { ReadonlySignal, Signal } from '@core/foundation/types.js' */

/**
 * A named set of controls. It answers for all of them whether they are valid,
 * changed, showing errors, editable and carrying server errors.
 *
 * A member is any `FormNode`, whether a `FormField`, a `FormGroup` or a `FormArray`.
 * The group asks the contract's questions and prefixes each answer with the member's
 * name. There is no base class.
 *
 * Paths are dotted, like `contacts.0.email`. The same string appears in
 * `firstInvalid`, in a 422 body, in `applyErrors` and on `<ui-field name>`, so
 * `focusInvalidField` finds the control with one `querySelector`.
 *
 * The second argument lists validators over the group's value, such as "the end day
 * may not precede the start day". Their code belongs to the group, and
 * `ui-form-error` shows it. A code that belongs under one control goes through
 * `applyErrors` instead, and clears when that control is edited.
 *
 * Group rules report last. An invalid member wins `invalidPath` and focus, because a
 * specific control is a better destination than a sentence about the form.
 *
 * @template {Record<string, FormNode>} F
 * @implements {FormNode}
 */
export class FormGroup {
  /** @type {F} */
  fields;

  /**
   * True once the form was submitted. It makes every error below here visible, so a
   * refused submit explains itself.
   */
  submitted = signal(false);

  /** @type {ReadonlySignal<boolean>} */
  valid;

  /** @type {ReadonlySignal<boolean>} */
  dirty;

  /**
   * True when every member is off. A form sets it while saving, so in-flight values
   * can't be edited.
   *
   * Write it with `setDisabled`. A member disabled on its own stays disabled when this
   * goes false. A container above this group is the second source.
   *
   * @type {ReadonlySignal<boolean>}
   */
  disabled;

  /**
   * The path of the first invalid control in declaration order, or the empty string.
   * A screen focuses it after a refused submit.
   *
   * @type {ReadonlySignal<string>}
   */
  firstInvalid;

  /** @type {ReadonlySignal<string | null>} */
  invalidPath;

  /**
   * True when every member has been visited and there is at least one. Disabled
   * members are skipped, since they can't be visited.
   *
   * @type {ReadonlySignal<boolean>}
   */
  touched;

  /** @type {ReadonlySignal<boolean>} */
  pending;

  /**
   * This group's own code, ignoring its members. Empty while disabled.
   *
   * @type {ReadonlySignal<string>}
   */
  error;

  /**
   * The group's own code once it may show, after a submit or once every member was
   * visited. A cross-field rule has no single control to leave.
   *
   * @type {ReadonlySignal<string>}
   */
  visibleError;

  /** @type {readonly (keyof F & string)[]} */
  #names;

  #ownDisabled = signal(false);

  /** @type {Signal<ReadonlySignal<boolean> | null>} */
  #inheritedDisabled = signal(null);

  /**
   * @param {F} fields Declaration order sets the order of `firstInvalid`.
   * @param {readonly Validator<{ [K in keyof F]: ValueOf<F[K]> }>[]} [validators]
   *   Rules over the group's value, run in order. The first failure wins.
   */
  constructor(fields, validators = []) {
    this.fields = fields;
    this.#names = /** @type {(keyof F & string)[]} */ (Object.keys(fields));
    this.disabled = computed(() => this.#ownDisabled.value || (this.#inheritedDisabled.value?.value ?? false));

    for (const name of this.#names) fields[name]?.inheritDisabled(this.disabled);

    // Without rules, `own` is a constant. A computed over `values` would subscribe
    // every reader of `valid` to every keystroke.
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
      () => this.#names.every((name) => fields[name]?.valid.value === true) && (this.disabled.value || own.value === ''),
    );
    this.dirty = computed(() => this.#names.some((name) => fields[name]?.dirty.value === true));
    this.pending = computed(() => this.#names.some((name) => fields[name]?.pending.value === true));

    this.touched = computed(
      () =>
        this.#names.length > 0 &&
        this.#names.every((name) => {
          const node = fields[name];
          return node === undefined || node.disabled.value || node.touched.value;
        }),
    );

    this.error = computed(() => (this.disabled.value ? '' : own.value));
    this.visibleError = computed(() => {
      if (this.error.value === '') return '';
      return this.submitted.value || this.touched.value ? this.error.value : '';
    });

    this.invalidPath = computed(() => {
      for (const name of this.#names) {
        const below = fields[name]?.invalidPath.value ?? null;
        if (below !== null) return prefix(name, below);
      }
      // `''` means the group itself, for a failing group rule.
      return this.disabled.value || own.value === '' ? null : '';
    });

    this.firstInvalid = computed(() => this.invalidPath.value ?? '');
  }

  /**
   * Every member's value by name, nested all the way down.
   *
   * A getter, because callers read it at submit time and a computed would subscribe
   * readers to every keystroke. Disabled members are included (see `FormField`).
   *
   * @returns {{ [K in keyof F]: ValueOf<F[K]> }}
   */
  get values() {
    /** @type {Record<string, unknown>} */
    const values = {};
    for (const name of this.#names) values[name] = this.fields[name]?.snapshot;
    return /** @type {{ [K in keyof F]: ValueOf<F[K]> }} */ (values);
  }

  /**
   * Mark the form submitted and report whether it may be sent.
   *
   *     if (!this.form.markSubmitted()) return focusFirstInvalid();
   *
   * @returns {boolean} Whether every control below here is valid.
   */
  markSubmitted() {
    this.submitted.value = true;
    for (const name of this.#names) this.fields[name]?.markSubmitted();
    return this.valid.value;
  }

  /**
   * Resolve once no asynchronous check below here is waiting or in flight.
   *
   *     await this.form.whenSettled();
   *     if (!this.form.markSubmitted()) return void focusInvalidField(this, this.form);
   *
   * Without the await, `markSubmitted()` refuses a form with pending checks and shows
   * no error to explain why.
   *
   * @returns {Promise<void>}
   */
  whenSettled() {
    return whenSettled(this.pending);
  }

  /**
   * Apply per-control error codes from a rejected write, the `fields` of a 422.
   *
   * A name may be a path, such as `email` or `contacts.0.email`, matching
   * `firstInvalid` and `<ui-field name>`.
   *
   * Unknown names and container paths come back unmatched, so the screen can still
   * tell the user. A code against `contacts` has no single control to show it.
   *
   * @param {Readonly<Record<string, string>>} errors
   * @returns {string[]} The paths that matched no control.
   */
  applyErrors(errors) {
    /** @type {string[]} */
    const unmatched = [];
    for (const [path, code] of Object.entries(errors)) {
      const node = this.leafAt(path.split('.'));
      if (node === null || !node.setServerError(code)) unmatched.push(path);
    }
    return unmatched;
  }

  /**
   * Disable or enable every member. A form calls this around a save.
   *
   * @param {boolean} next
   */
  setDisabled(next) {
    this.#ownDisabled.value = next;
  }

  /**
   * The path of the first control with a server error, or the empty string. Disabled
   * controls are skipped, because the caller is about to focus the result.
   */
  get firstServerError() {
    return this.serverErrorPath ?? '';
  }

  clearServerErrors() {
    for (const name of this.#names) this.fields[name]?.clearServerErrors();
  }

  /**
   * Set values without moving the clean baseline, for defaults the user may still
   * change.
   *
   * It goes deep. A nested group takes an object, an array takes a list, and missing
   * members are left alone. An array given a different length resizes (see
   * `FormArray.patch`).
   *
   * @param {Partial<{ [K in keyof F]: PartialValueOf<F[K]> }>} values
   */
  patch(values) {
    for (const [name, value] of Object.entries(values)) {
      // Own members only, so a key like `constructor` can't resolve off
      // `Object.prototype`.
      if (value !== undefined && Object.hasOwn(this.fields, name)) this.fields[name]?.fill(value);
    }
  }

  /**
   * Return to a clean state at these values, or at the last clean values. The
   * baseline moves, so a form reset to the server's response isn't dirty.
   *
   * @param {Partial<{ [K in keyof F]: PartialValueOf<F[K]> }>} [values]
   */
  reset(values) {
    this.submitted.value = false;
    for (const name of this.#names) {
      const node = this.fields[name];
      if (node === undefined) continue;
      const next = values?.[name];
      if (next === undefined) node.reset();
      else node.reset(next);
    }
  }

  /* ── The FormNode contract ──────────────────────────────────────────────── */

  /** @returns {{ [K in keyof F]: ValueOf<F[K]> }} */
  get snapshot() {
    return this.values;
  }

  /** @returns {string | null} */
  get serverErrorPath() {
    for (const name of this.#names) {
      const below = this.fields[name]?.serverErrorPath ?? null;
      if (below !== null) return prefix(name, below);
    }
    return null;
  }

  /** @param {unknown} value */
  fill(value) {
    this.patch(/** @type {Partial<{ [K in keyof F]: PartialValueOf<F[K]> }>} */ (value));
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
    if (head === undefined) return null;
    // `Object.hasOwn`, so `constructor` or `toString` can't resolve off the prototype.
    if (!Object.hasOwn(this.fields, head)) return null;
    return this.fields[head]?.leafAt(rest) ?? null;
  }

  /**
   * @param {string} _code
   * @returns {boolean} Always false. See `FormArray.setServerError`.
   */
  setServerError(_code) {
    return false;
  }
}

/**
 * A member's path as seen from its container. An empty `below` means the member
 * itself.
 *
 * @param {string} name
 * @param {string} below
 * @returns {string}
 */
function prefix(name, below) {
  return below === '' ? name : `${name}.${below}`;
}

/**
 * Create a group.
 *
 *     const form = group({
 *       name: field('', [required(), maxLength(80)]),
 *       email: field('', [required(), email()]),
 *     });
 *
 *     const period = group({ start: field(''), end: field('') }, [ordered('start', 'end')]);
 *
 * @template {Record<string, FormNode>} F
 * @param {F} fields
 * @param {readonly Validator<{ [K in keyof F]: ValueOf<F[K]> }>[]} [validators]
 * @returns {FormGroup<F>}
 */
export function group(fields, validators) {
  return new FormGroup(fields, validators);
}
