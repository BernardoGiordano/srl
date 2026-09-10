import { batch, computed, signal } from '@core/foundation/reactive.js';

import { whenSettled } from '@core/forms/settled.js';

/** @import { AsyncValidator, FieldOptions, FormLifetime, FormNode, Validator, Widened } from '@core/forms/types.js' */
/** @import { ReadonlySignal, Signal } from '@core/foundation/types.js' */

/** Milliseconds of quiet before an asynchronous check starts. */
const DEFAULT_DEBOUNCE = 300;

/**
 * No asynchronous answer is held for any value.
 *
 * A sentinel rather than a boolean beside the stored value, because `undefined`
 * and `null` are both values a field can legitimately hold.
 */
const UNCHECKED = Symbol('unchecked');

/**
 * One editable value, and everything a control needs to know about it: the value,
 * the touched flag, the "may this error be shown yet" rule, the server error and
 * its clear-on-edit, and the dirty comparison. That list came from measuring a
 * screen that hand-rolled all five.
 *
 * Not Angular's `FormControl`: no `updateOn`, no `statusChanges`, and no
 * hierarchy. What this class shares with `FormGroup` and `FormArray` is the
 * `FormNode` interface in `@core/forms/types.js`, not a base class. ADR-0006.
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
 * Below the server come the synchronous rules, and below those the asynchronous
 * one, which never collides with them: it does not run until they all pass.
 *
 * AN ASYNCHRONOUS RULE IS A ROUND TRIP THIS FIELD OWNS
 *
 * `{ async: [notTaken()] }` and the field debounces the keystrokes, aborts the
 * check the next keystroke supersedes, aborts again when its owner's lifetime
 * does, and remembers the value it last got an answer for so a re-render does not
 * ask twice. What an application writes is a function from a value to a code.
 * ADR-0103.
 *
 * A check never runs for the value the field was *built* with, or for one a
 * `reset` installed. Those came from the server, and a form opened on a saved
 * customer would otherwise report that customer's own address as taken.
 *
 * `pending` is the state a submit has to respect: not valid, not invalid, no
 * error to show. `whenSettled()` is how a submit waits for it.
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
   * The code the last settled asynchronous check produced, for the value it
   * checked. Empty while nothing has been checked, and cleared the moment the
   * value moves away from the one it describes.
   */
  asyncError = signal('');

  /**
   * A check is waiting out its debounce or is in flight.
   *
   * False while the field is disabled, whichever way it was switched off: a form
   * that disables itself to save must not be held up by a check whose answer it
   * would ignore.
   *
   * @type {ReadonlySignal<boolean>}
   */
  pending;

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

  /** @type {readonly AsyncValidator<T>[]} */
  #asyncValidators;

  #debounce = DEFAULT_DEBOUNCE;

  /** @type {FormLifetime | undefined} */
  #lifetime;

  /** Waiting or in flight, before `disabled` is taken into account. */
  #checking = signal(false);

  /** The check in flight, or none. Anything else that resolves is superseded. */
  /** @type {AbortController | undefined} */
  #request;

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #timer;

  /**
   * The value `asyncError` is an answer about, when there is one. A sentinel
   * rather than a flag beside it, because `undefined` is a value a field can hold.
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

    // The first failing code, which is why validators are ordered: `required`
    // before `minLength` means an empty field says "required" rather than
    // "too short", and a field that reported both would be a field showing two
    // sentences for one mistake.
    const own = computed(() => this.#validateSync(this.value.value));

    this.disabled = computed(() => this.#ownDisabled.value || (this.#inheritedDisabled.value?.value ?? false));

    // A check whose answer would be ignored does not hold a submit up.
    this.pending = computed(() => !this.disabled.value && this.#checking.value);

    // A disabled field has nothing to say. The server's answer is kept rather
    // than cleared — it describes a value that is still in the form and still
    // going to be sent — and reappears if the field is enabled again.
    this.error = computed(() => {
      if (this.disabled.value) return '';
      if (this.serverError.value !== '') return this.serverError.value;
      return own.value !== '' ? own.value : this.asyncError.value;
    });

    // `valid` ignores the server's answer on purpose. A 422 describes a value
    // that has since been edited or is about to be resubmitted, and a form that
    // treated it as invalidity would refuse the submit that is the only way to
    // find out whether the new value is acceptable.
    //
    // A disabled field is valid for a blunter reason: there is no control to
    // correct, so a form that refused to submit for it would refuse for good.
    // A pending field is not valid. The value is not known to be acceptable, and
    // the alternative — reporting it valid — is how an unchecked value is sent.
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
   * The documented way to write the value. `field.value.value = x` reaches the
   * same signal and skips both of the rules below, which is why screens are told
   * to call this.
   *
   * @param {T} next
   */
  setValue(next) {
    this.value.value = next;
    if (this.serverError.value !== '') this.serverError.value = '';
    this.#scheduleCheck();
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
   * Resolve once no asynchronous check is waiting or in flight. What a submit
   * awaits before asking `markSubmitted()`.
   *
   * @returns {Promise<void>}
   */
  whenSettled() {
    return whenSettled(this.pending);
  }

  /* ── Asynchronous checks ────────────────────────────────────────────────── */

  /**
   * The first failing synchronous code, which is why validators are ordered:
   * `required` before `minLength` means an empty field says "required" rather
   * than "too short", and a field that reported both would be a field showing two
   * sentences for one mistake.
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
   * Decide what the current value owes an asynchronous check, and start the clock
   * if it owes one.
   *
   * Four of the five branches end without a request, which is the point: the
   * cheapest check is the one a keystroke does not cause.
   */
  #scheduleCheck() {
    if (this.#asyncValidators.length === 0) return;
    this.#cancelCheck();

    const value = this.value.value;

    // Already answered for this exact value. A control that re-emits `input` with
    // an unchanged value, or a field written back after a render, asks nothing.
    if (this.#checked !== UNCHECKED && this.#equals(/** @type {T} */ (this.#checked), value)) return;

    this.#checked = UNCHECKED;

    // A malformed address is not worth a round trip, and "taken" under a value the
    // user has not finished typing is the wrong sentence for the wrong reason.
    if (this.#validateSync(value) !== '') {
      this.asyncError.value = '';
      return;
    }

    batch(() => {
      this.asyncError.value = '';
      this.#checking.value = true;
    });
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#runCheck(value);
    }, this.#debounce);
  }

  /**
   * Ask every asynchronous validator in order, first failure wins.
   *
   * @param {T} value
   * @returns {Promise<void>}
   */
  async #runCheck(value) {
    const lifetime = typeof this.#lifetime === 'function' ? this.#lifetime() : this.#lifetime;

    // Nothing is listening any more: not asking is the same answer as asking and
    // dropping the response, one request cheaper.
    if (lifetime?.aborted === true) {
      this.#settle(value, '');
      return;
    }

    const request = new AbortController();
    this.#request = request;
    const abortWithOwner = () => request.abort(lifetime?.reason);

    // Two removals, for the two ways a check ends. `signal: request.signal` covers
    // a supersession whose validator never settles; the `finally` covers one that
    // settles, which never aborts and would otherwise leave a listener per
    // keystroke on a lifetime that outlives all of them. ADR-0076.
    lifetime?.addEventListener('abort', abortWithOwner, { once: true, signal: request.signal });

    try {
      let code = '';
      for (const validate of this.#asyncValidators) {
        code = await validate(value, request.signal);
        if (this.#request !== request) return;
        if (code !== '') break;
      }
      this.#settle(value, code);
    } catch {
      // A check that could not run has not found anything wrong. The write is what
      // decides, the same way `resource` refuses to turn a rejection into a value.
      if (this.#request === request) this.#settle(value, '');
    } finally {
      lifetime?.removeEventListener('abort', abortWithOwner);
      if (this.#request === request) this.#request = undefined;
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

  /** Drop the timer and abort the request, without deciding what replaces them. */
  #cancelCheck() {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#request?.abort();
    this.#request = undefined;
    this.#checking.value = false;
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
  // Cast rather than parametrise the class: `Signal<T>` is invariant, so
  // `FormField<''>` is not a `FormField<string>` however obviously it should be.
  // The widening is a fact about inference, not about the field.
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
