import { computed, signal } from '@core/foundation/reactive.js';

/** @import { FormNode, Validator, Widened } from '@core/forms/types.js' */
/** @import { ReadonlySignal, Signal } from '@core/foundation/types.js' */

/**
 * One editable value, and everything a control needs to know about it: the value,
 * the touched flag, the "may this error be shown yet" rule, the server error and
 * its clear-on-edit, and the dirty comparison. That list came from measuring a
 * screen that hand-rolled all five.
 *
 * Not Angular's `FormControl`: no `updateOn`, no async validators, no
 * `statusChanges`, and no hierarchy. What this class shares with `FormGroup` and
 * `FormArray` is the `FormNode` interface in `@core/forms/types.js`, not a base class.
 * ADR-0006.
 *
 * The contract's half of this class is the untyped half. `snapshot` is
 * `value.value`, `fill` is `setValue`, `setServerError` writes the signal of
 * that name; each pair exists because a parent reading a node it cannot name
 * needs a signature that does not mention `T`.
 *
 * DISABLED IS A STATE, NOT A DELETION
 *
 * A disabled field stops being answerable for: its validators do not run, it
 * reports `valid`, and it shows no error. It keeps its value, so `group.values`
 * and `dirty` both still count it — deliberately unlike Angular. ADR-0007.
 *
 * VALUES ARE WHATEVER THE CONTROL HOLDS
 *
 * Usually a string, because that is what a DOM control gives back; `string[]` for
 * a multi-select, a boolean for a checkbox. The type parameter follows the initial
 * value and the validators are typed against it. Conversion happens at the service
 * boundary, not per keystroke. ADR-0008.
 *
 * ERROR PRECEDENCE, WHICH IS THE ONE RULE WORTH READING
 *
 * A server error outranks every validator: it is the authority, and some rules —
 * a name and an email address are unique — cannot be checked here at all. That
 * answer is about the value that was *sent*, so `setValue` clears it. Left in
 * place it outlives the correction, and the form looks broken to the one user who
 * did what it asked.
 *
 * @template T
 * @implements {FormNode}
 */
export class FormField {
  /** @type {Signal<T>} */
  value;

  /** Left at least once. Errors stay quiet until then. */
  touched = signal(false);

  /**
   * The form has been submitted. Written by the group, and the second half of
   * the timing rule: on submit every error becomes visible at once, including
   * the ones under fields the user never reached.
   */
  submitted = signal(false);

  /** The server's code for this field, or the empty string. */
  serverError = signal('');

  /**
   * Not editable: by this field's own switch, or by the group's.
   *
   * Read it, write it with `setDisabled`. The two-source shape is why it is a
   * computed rather than a plain signal like `touched`: a form disabled while it
   * saves must not, on re-enabling, switch on the one field a domain rule had
   * disabled all along.
   *
   * @type {ReadonlySignal<boolean>}
   */
  disabled;

  /** @type {ReadonlySignal<string>} */
  error;

  /** @type {ReadonlySignal<string>} */
  visibleError;

  /** @type {ReadonlySignal<boolean>} */
  valid;

  /** @type {ReadonlySignal<boolean>} */
  dirty;

  /**
   * `''` when this field is the invalid one, `null` when it is not. A leaf has
   * no path below it, so those are the only two answers it can give.
   *
   * @type {ReadonlySignal<string | null>}
   */
  invalidPath;

  /** @type {Signal<T>} What `reset()` with no argument returns to. */
  #baseline;

  /** This field's own half of `disabled`. */
  #ownDisabled = signal(false);

  /**
   * The group's half, once there is a group. A signal holding a signal rather
   * than a plain property, because `disabled` is computed before the group links
   * it and a computed cannot depend on a value nothing notifies it about.
   *
   * @type {Signal<ReadonlySignal<boolean> | null>}
   */
  #inheritedDisabled = signal(null);

  /** @type {readonly Validator<T>[]} */
  #validators;

  /** @type {(left: T, right: T) => boolean} */
  #equals;

  /**
   * @param {T} initial
   * @param {readonly Validator<T>[]} [validators] Run in order; the first failure wins.
   * @param {{ equals?: (left: T, right: T) => boolean }} [options]
   */
  constructor(initial, validators = [], options = {}) {
    this.value = signal(initial);
    this.#baseline = signal(initial);
    this.#validators = validators;
    this.#equals = options.equals ?? sameValue;

    // The first failing code, which is why validators are ordered: `required`
    // before `minLength` means an empty field says "required" rather than
    // "too short", and a field that reported both would be a field showing two
    // sentences for one mistake.
    const own = computed(() => {
      for (const validate of this.#validators) {
        const code = validate(this.value.value);
        if (code !== '') return code;
      }
      return '';
    });

    this.disabled = computed(() => this.#ownDisabled.value || (this.#inheritedDisabled.value?.value ?? false));

    // A disabled field has nothing to say. The server's answer is kept rather
    // than cleared — it describes a value that is still in the form and still
    // going to be sent — and reappears if the field is enabled again.
    this.error = computed(() => {
      if (this.disabled.value) return '';
      return this.serverError.value === '' ? own.value : this.serverError.value;
    });

    // `valid` ignores the server's answer on purpose. A 422 describes a value
    // that has since been edited or is about to be resubmitted, and a form that
    // treated it as invalidity would refuse the submit that is the only way to
    // find out whether the new value is acceptable.
    //
    // A disabled field is valid for a blunter reason: there is no control to
    // correct, so a form that refused to submit for it would refuse for good.
    this.valid = computed(() => this.disabled.value || own.value === '');

    this.visibleError = computed(() => {
      if (this.error.value === '') return '';
      const shown = this.serverError.value !== '' || this.submitted.value || this.touched.value;
      return shown ? this.error.value : '';
    });

    this.dirty = computed(() => !this.#equals(this.value.value, this.#baseline.value));
    this.invalidPath = computed(() => (this.valid.value ? null : ''));
  }

  /**
   * @param {T} next
   */
  setValue(next) {
    this.value.value = next;
    if (this.serverError.value !== '') this.serverError.value = '';
  }

  /** The control was left. Idempotent, so a blur handler can call it freely. */
  touch() {
    if (!this.touched.value) this.touched.value = true;
  }

  /**
   * Switch this field off, or back on.
   *
   * Only this field's own half: a field the group has disabled stays disabled
   * until the group enables it, which is what makes `setDisabled(false)` on a
   * saving form a no-op rather than a hole in the busy state.
   *
   * `setValue`, `patch` and `reset` still work on a disabled field. They are how
   * a screen fills a control the user may not edit, and refusing them would mean
   * a loaded form could not show what it loaded.
   *
   * @param {boolean} next
   */
  setDisabled(next) {
    this.#ownDisabled.value = next;
  }

  /**
   * Take the group's disabled state as a second source.
   *
   * Called by `FormGroup` for each of its fields, and the reason a field does
   * not hold a reference to its group: one signal is the whole of what a field
   * needs from above, and a link that narrow cannot grow into a hierarchy.
   *
   * @param {ReadonlySignal<boolean>} source
   */
  inheritDisabled(source) {
    this.#inheritedDisabled.value = source;
  }

  /**
   * Back to a clean state, at `next` or at the value this field was built with.
   *
   * Also moves the baseline, which is what makes a saved form stop being dirty
   * without being rebuilt: the values that came back from the server are the new
   * "unchanged".
   *
   * Disabled is not cleaned up here. It is the screen's rule about who may edit
   * what, not a trace the user left, and a reset that switched a read-only field
   * back on would hand the wrong person a control.
   *
   * @param {T} [next]
   */
  reset(next) {
    const value = next === undefined ? this.#baseline.value : next;
    this.#baseline.value = value;
    this.value.value = value;
    this.touched.value = false;
    this.submitted.value = false;
    this.serverError.value = '';
  }

  /* ── The FormNode contract ──────────────────────────────────────────────
   *
   * Everything below is a one-line restatement of something above, under a name
   * that mentions no type parameter. A `FormGroup` holding this field does not
   * know it is holding a field, so it cannot call `setValue(next: T)`; it calls
   * `fill(value: unknown)`, and the cast happens here, once, where the field is
   * the thing that knows what it holds.
   */

  /** @returns {T} */
  get snapshot() {
    return this.value.value;
  }

  /**
   * `''` when this field is carrying the server's answer, `null` when it is not.
   *
   * A disabled field says `null` even while it holds one: the caller is a screen
   * about to focus what this names, and sending focus to a control the user
   * cannot type in is the failure that looks like nothing happening.
   *
   * @returns {string | null}
   */
  get serverErrorPath() {
    return this.serverError.value !== '' && !this.disabled.value ? '' : null;
  }

  /** @param {unknown} value */
  fill(value) {
    this.setValue(/** @type {T} */ (value));
  }

  /**
   * Make this field's error visible and report whether it may be sent.
   *
   * `touched` is left alone. Submitting is not visiting, and a form that marked
   * every field touched would report the user as having been somewhere they
   * were not — which is the flag `visibleError` reads to decide the *other* half
   * of the timing rule.
   *
   * @returns {boolean}
   */
  markSubmitted() {
    this.submitted.value = true;
    return this.valid.value;
  }

  clearServerErrors() {
    this.serverError.value = '';
  }

  /**
   * @param {readonly string[]} path
   * @returns {FormNode | null} This field, when the path ends here.
   */
  leafAt(path) {
    return path.length === 0 ? this : null;
  }

  /**
   * @param {string} code
   * @returns {boolean} Always true: a field is what a per-field code is for.
   */
  setServerError(code) {
    this.serverError.value = code;
    return true;
  }
}

/**
 * One field.
 *
 *     const name = field('', [required(), maxLength(80)]);
 *     const segment = field('', [required()]);
 *     const tags = field(EMPTY_CODES);              // `readonly string[]`, inferred
 *
 * @template T
 * @param {T} initial
 * @param {readonly Validator<Widened<T>>[]} [validators]
 * @param {{ equals?: (left: Widened<T>, right: Widened<T>) => boolean }} [options]
 * @returns {FormField<Widened<T>>}
 */
export function field(initial, validators, options) {
  // Cast rather than parametrise the class: `Signal<T>` is invariant, so
  // `FormField<''>` is not a `FormField<string>` however obviously it should be.
  // The widening is a fact about inference, not about the field.
  return /** @type {FormField<Widened<T>>} */ (
    /** @type {unknown} */ (
      new FormField(
        initial,
        /** @type {readonly Validator<T>[]} */ (validators),
        /** @type {{ equals?: (left: T, right: T) => boolean }} */ (
          /** @type {unknown} */ (options)
        ),
      )
    )
  );
}

/**
 * The default comparison behind `dirty`.
 *
 * Element-wise for arrays, because a multi-select's value is one, and
 * `Object.is` on two arrays holding the same three codes says they differ — a
 * form that is dirty the moment it loads. Order counts: reordering a selection
 * is an edit.
 *
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
function sameValue(left, right) {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((entry, index) => Object.is(entry, right[index]));
  }
  return Object.is(left, right);
}
