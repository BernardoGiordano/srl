import { batch, computed, signal } from '@core/foundation/reactive.js';

import { whenSettled } from '@core/forms/settled.js';

/** @import { AsyncValidator, FieldOptions, FormLifetime, FormNode, Validator, Widened } from '@core/forms/types.js' */
/** @import { ReadonlySignal, Signal } from '@core/foundation/types.js' */

/** Milliseconds of quiet before an asynchronous check starts. */
const DEFAULT_DEBOUNCE = 300;

/**
 * Marks that no asynchronous answer is held. A symbol, because `undefined` and `null`
 * are valid field values.
 */
const UNCHECKED = Symbol('unchecked');

/**
 * One editable value, with its touched flag, error visibility rule, server error,
 * dirty comparison and optional asynchronous check.
 *
 * It isn't Angular's `FormControl`. There is no `updateOn`, no `statusChanges` and no
 * class hierarchy. `FormField`, `FormGroup` and `FormArray` share the `FormNode`
 * interface in `@core/forms/types.js`.
 *
 * A disabled field skips its validators, reports `valid` and shows no error. It keeps
 * its value, so `group.values` and `dirty` still include it. Angular drops disabled
 * values, and a payload silently missing a column is the worse outcome.
 *
 * Values are whatever the control holds: a string, `string[]` for a multi-select, a
 * boolean for a checkbox. The type follows the initial value. Convert to domain types
 * at the service boundary.
 *
 * Errors follow a fixed precedence. A server error outranks every validator, since
 * some rules, like uniqueness, can only be checked there. It describes the value that
 * was sent, so `setValue` clears it. Synchronous rules come next, and the asynchronous
 * check runs only once they all pass.
 *
 * `{ async: [notTaken()] }` adds an asynchronous check. The field debounces
 * keystrokes, aborts a check the next keystroke supersedes, aborts when its owner's
 * lifetime ends and remembers the last value it checked.
 *
 * When the owner's lifetime ends, the field stops pending and drops any late answer,
 * even from a validator that ignores its abort signal, so `whenSettled()` never hangs.
 *
 * No check runs for the initial value or a value set by `reset`. Those come from the
 * server, and a saved customer's own address must not report as taken.
 *
 * While `pending`, the field is neither valid nor showing an error. A submit waits
 * with `whenSettled()`.
 *
 * @template T
 * @implements {FormNode}
 */
export class FormField {
  /** @type {Signal<T>} */
  value;

  /** True once the control has been left. Errors stay hidden until then. */
  touched = signal(false);

  /**
   * True once the form was submitted. The group writes it, and it makes every error
   * visible, including errors under fields the user never reached.
   */
  submitted = signal(false);

  /** The server's code for this field, or the empty string. */
  serverError = signal('');

  /**
   * The code from the last settled asynchronous check. Empty until a check settles,
   * and cleared as soon as the value changes.
   */
  asyncError = signal('');

  /**
   * True while a check waits out its debounce or is in flight. Always false while
   * disabled, so a form that disables itself to save isn't held up by a check it
   * would ignore.
   *
   * @type {ReadonlySignal<boolean>}
   */
  pending;

  /**
   * True when this field or its group disabled it. Write it with `setDisabled`.
   *
   * It combines two sources, so re-enabling a form after a save doesn't enable a field
   * that a domain rule disabled.
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
   * `''` when this field is invalid, `null` otherwise.
   *
   * @type {ReadonlySignal<string | null>}
   */
  invalidPath;

  /** @type {Signal<T>} What `reset()` with no argument returns to. */
  #baseline;

  /** This field's own half of `disabled`. */
  #ownDisabled = signal(false);

  /**
   * The group's half of `disabled`. A signal holding a signal, because `disabled` is
   * computed before the group links it.
   *
   * @type {Signal<ReadonlySignal<boolean> | null>}
   */
  #inheritedDisabled = signal(null);

  /** @type {readonly Validator<T>[]} */
  #validators;

  /** @type {readonly AsyncValidator<T>[]} */
  #asyncValidators;

  #debounce = DEFAULT_DEBOUNCE;

  /** @type {FormLifetime | undefined} */
  #lifetime;

  /** Waiting or in flight, before `disabled` is taken into account. */
  #checking = signal(false);

  /** The check in flight. A check that resolves after being replaced is ignored. */
  /** @type {AbortController | undefined} */
  #request;

  /**
   * Removes the owner listener of the current check. Cleared on every path that ends a
   * check.
   *
   * @type {(() => void) | undefined}
   */
  #release;

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #timer;

  /**
   * The value `asyncError` answers for, or `UNCHECKED`.
   *
   * @type {T | typeof UNCHECKED}
   */
  #checked = UNCHECKED;

  /** @type {(left: T, right: T) => boolean} */
  #equals;

  /**
   * @param {T} initial
   * @param {readonly Validator<T>[]} [validators] Run in order; the first failure wins.
   * @param {FieldOptions<T>} [options]
   */
  constructor(initial, validators = [], options = {}) {
    this.value = signal(initial);
    this.#baseline = signal(initial);
    this.#validators = validators;
    this.#equals = options.equals ?? sameValue;
    this.#asyncValidators = options.async ?? [];
    this.#debounce = options.debounce ?? DEFAULT_DEBOUNCE;
    this.#lifetime = options.lifetime;

    // Validators run in order and the first failure wins, so `required` before
    // `minLength` reports "required" for an empty field.
    const own = computed(() => this.#validateSync(this.value.value));

    this.disabled = computed(() => this.#ownDisabled.value || (this.#inheritedDisabled.value?.value ?? false));

    // A check whose answer would be ignored doesn't hold up a submit.
    this.pending = computed(() => !this.disabled.value && this.#checking.value);

    // A disabled field shows no error. The server error is kept, because its value is
    // still in the form, and it reappears if the field is enabled.
    this.error = computed(() => {
      if (this.disabled.value) return '';
      if (this.serverError.value !== '') return this.serverError.value;
      return own.value !== '' ? own.value : this.asyncError.value;
    });

    // `valid` ignores the server error. A 422 describes a value that was edited or is
    // about to be resubmitted, and resubmitting is the only way to learn whether the
    // new value is accepted.
    //
    // A disabled field is valid, because the user can't correct it. A pending field
    // isn't, because its value isn't known to be acceptable yet.
    this.valid = computed(
      () => this.disabled.value || (own.value === '' && this.asyncError.value === '' && !this.#checking.value),
    );

    this.visibleError = computed(() => {
      if (this.error.value === '') return '';
      const shown = this.serverError.value !== '' || this.submitted.value || this.touched.value;
      return shown ? this.error.value : '';
    });

    this.dirty = computed(() => !this.#equals(this.value.value, this.#baseline.value));
    this.invalidPath = computed(() => (this.valid.value ? null : ''));
  }

  /**
   * Write the value, clear the server error and schedule the asynchronous check.
   * Writing `field.value.value` directly skips the last two.
   *
   * @param {T} next
   */
  setValue(next) {
    this.value.value = next;
    if (this.serverError.value !== '') this.serverError.value = '';
    this.#scheduleCheck();
  }

  /** Mark the control as left. Idempotent, so a blur handler can call it freely. */
  touch() {
    if (!this.touched.value) this.touched.value = true;
  }

  /**
   * Disable or enable this field.
   *
   * This sets only the field's own half. A field the group disabled stays disabled
   * until the group enables it.
   *
   * `setValue`, `patch` and `reset` still work while disabled, so a screen can fill a
   * read-only control.
   *
   * @param {boolean} next
   */
  setDisabled(next) {
    this.#ownDisabled.value = next;
  }

  /**
   * Use the group's disabled state as a second source. `FormGroup` calls this for
   * each member, and the field keeps no other reference to its group.
   *
   * @param {ReadonlySignal<boolean>} source
   */
  inheritDisabled(source) {
    this.#inheritedDisabled.value = source;
  }

  /**
   * Return to a clean state at `next`, or at the baseline.
   *
   * The baseline moves too, so a saved form stops being dirty without a rebuild. The
   * disabled state is left alone, because it's the screen's rule about who may edit,
   * and a reset must not re-enable a read-only field.
   *
   * @param {T} [next]
   */
  reset(next) {
    const value = next === undefined ? this.#baseline.value : next;
    this.#cancelCheck();
    this.#checked = UNCHECKED;
    this.#baseline.value = value;
    this.value.value = value;
    this.touched.value = false;
    this.submitted.value = false;
    this.serverError.value = '';
    this.asyncError.value = '';
  }

  /**
   * Resolve once no asynchronous check is waiting or in flight. A submit awaits this
   * before calling `markSubmitted()`.
   *
   * @returns {Promise<void>}
   */
  whenSettled() {
    return whenSettled(this.pending);
  }

  /* ── Asynchronous checks ────────────────────────────────────────────────── */

  /**
   * The first failing synchronous code, or the empty string.
   *
   * @param {T} value
   * @returns {string}
   */
  #validateSync(value) {
    for (const validate of this.#validators) {
      const code = validate(value);
      if (code !== '') return code;
    }
    return '';
  }

  /**
   * Decide whether the current value needs an asynchronous check, and start the
   * debounce if it does. Most branches end without a request.
   */
  #scheduleCheck() {
    if (this.#asyncValidators.length === 0) return;
    this.#cancelCheck();

    const value = this.value.value;

    // Already answered for this exact value, so a re-emitted `input` asks nothing.
    if (this.#checked !== UNCHECKED && this.#equals(/** @type {T} */ (this.#checked), value)) return;

    this.#checked = UNCHECKED;

    // A value that fails a synchronous rule isn't worth a round trip.
    if (this.#validateSync(value) !== '') {
      this.asyncError.value = '';
      return;
    }

    // The owner is gone, so skip the request. The value stays unchecked, so a
    // returning owner asks again.
    const lifetime = this.#ownerLifetime();
    if (lifetime?.aborted === true) {
      this.asyncError.value = '';
      return;
    }

    const request = new AbortController();
    this.#request = request;

    if (lifetime !== undefined) {
      // Bind to the owner at scheduling time, so an owner that ends during the
      // debounce ends the check too.
      const abandonWithOwner = () => {
        request.abort(lifetime.reason);
        if (this.#request === request) this.#abandonCheck();
      };

      // `signal: request.signal` removes the listener when a check is superseded, and
      // `#release` removes it when a check settles. Without both, a long-lived lifetime
      // would collect one listener per keystroke. ADR-0076.
      lifetime.addEventListener('abort', abandonWithOwner, { once: true, signal: request.signal });
      this.#release = () => lifetime.removeEventListener('abort', abandonWithOwner);
    }

    batch(() => {
      this.asyncError.value = '';
      this.#checking.value = true;
    });
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#runCheck(value, request);
    }, this.#debounce);
  }

  /**
   * The owner's current lifetime. Read per check, because an element gets a new
   * lifetime signal after every re-attach.
   *
   * @returns {AbortSignal | undefined}
   */
  #ownerLifetime() {
    return typeof this.#lifetime === 'function' ? this.#lifetime() : this.#lifetime;
  }

  /**
   * Run every asynchronous validator in order. The first failure wins.
   *
   * @param {T} value
   * @param {AbortController} request
   * @returns {Promise<void>}
   */
  async #runCheck(value, request) {
    try {
      let code = '';
      for (const validate of this.#asyncValidators) {
        code = await validate(value, request.signal);
        if (this.#request !== request) return;
        if (code !== '') break;
      }
      this.#settle(value, code);
    } catch {
      // A check that couldn't run found nothing wrong, and the write decides.
      if (this.#request === request) this.#settle(value, '');
    } finally {
      if (this.#request === request) {
        this.#release?.();
        this.#release = undefined;
        this.#request = undefined;
      }
    }
  }

  /**
   * @param {T} value
   * @param {string} code
   */
  #settle(value, code) {
    this.#checked = value;
    batch(() => {
      this.asyncError.value = code;
      this.#checking.value = false;
    });
  }

  /** Drop the timer, the listener and the request, without deciding what replaces them. */
  #cancelCheck() {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#release?.();
    this.#release = undefined;
    this.#request?.abort();
    this.#request = undefined;
    this.#checking.value = false;
  }

  /**
   * The owner's lifetime ended. Drop the check and hold no answer for its value.
   *
   * Aborting only asks a validator to stop. Clearing the current request drops a late
   * answer, and clearing `pending` releases a submit waiting on `whenSettled()`.
   */
  #abandonCheck() {
    this.#cancelCheck();
    this.#checked = UNCHECKED;
  }

  /* ── The FormNode contract ──────────────────────────────────────────────
   *
   * Untyped versions of the members above. A parent group can't call
   * `setValue(next: T)` without knowing `T`, so it calls `fill(value: unknown)` and
   * the cast happens here.
   */

  /** @returns {T} */
  get snapshot() {
    return this.value.value;
  }

  /**
   * `''` when this field carries a server error, `null` otherwise. A disabled field
   * returns `null`, because the caller is about to focus the control it names.
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
   * Make this field's error visible and report whether it may be sent. `touched`
   * stays as it is, because submitting isn't visiting.
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
 * Create a field.
 *
 *     const name = field('', [required(), maxLength(80)]);
 *     const segment = field('', [required()]);
 *     const tags = field(EMPTY_CODES);              // `readonly string[]`, inferred
 *
 *     const email = field('', [required(), email()], {
 *       async: [notTaken()],
 *       lifetime: () => this.lifetime,
 *     });
 *
 * @template T
 * @param {T} initial
 * @param {readonly Validator<Widened<T>>[]} [validators]
 * @param {FieldOptions<Widened<T>>} [options]
 * @returns {FormField<Widened<T>>}
 */
export function field(initial, validators, options) {
  // A cast, because `Signal<T>` is invariant and `FormField<''>` isn't assignable to
  // `FormField<string>`. The widening only fixes inference.
  return /** @type {FormField<Widened<T>>} */ (
    /** @type {unknown} */ (
      new FormField(
        initial,
        /** @type {readonly Validator<T>[]} */ (validators),
        /** @type {FieldOptions<T>} */ (/** @type {unknown} */ (options)),
      )
    )
  );
}

/**
 * The default comparison behind `dirty`.
 *
 * Arrays compare element by element, so a multi-select isn't dirty on load. Order
 * counts, because reordering a selection is an edit.
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
