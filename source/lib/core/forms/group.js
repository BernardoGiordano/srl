import { computed, signal } from '@core/foundation/reactive.js';

/** @import { FormNode, PartialValueOf, ValueOf } from '@core/forms/types.js' */
/** @import { ReadonlySignal, Signal } from '@core/foundation/types.js' */

/**
 * A named set of controls, and the five questions a screen asks of all of them
 * at once: are they valid, has anything changed, may errors be shown, may they
 * be edited at all, and what did the server say.
 *
 * WHAT A MEMBER IS
 *
 * Any `FormNode`: a `FormField`, another `FormGroup`, or a `FormArray`. This
 * class never checks which. It asks the contract's questions and prefixes the
 * answers with the member's name, which is the whole of what nesting costs
 * here — there is no hierarchy, no base class, and no `AbstractControl`. ADR-0006.
 *
 * NAMES ARE PATHS
 *
 * `firstInvalid` used to be a field name and is now a dotted path:
 * `contacts.0.email`. For a flat form the two are the same string, which is why
 * nothing about a flat form changed. What it buys is that one convention
 * addresses a control at any depth, and the same string is what a 422 carries,
 * what `applyErrors` resolves and what `<ui-field name>` is set to — so
 * `focusInvalidField` still finds the control with one `querySelector`.
 *
 * @template {Record<string, FormNode>} F
 * @implements {FormNode}
 */
export class FormGroup {
  /** @type {F} */
  fields;

  /**
   * Submitted at least once. Reading it is rarely useful; its effect is: every
   * error below here becomes visible, which is what makes a submit that fails
   * validation say why rather than doing nothing.
   */
  submitted = signal(false);

  /** @type {ReadonlySignal<boolean>} */
  valid;

  /** @type {ReadonlySignal<boolean>} */
  dirty;

  /**
   * Every member is off. What a form sets while it saves, so the user cannot
   * edit the values that are in flight.
   *
   * Read it, write it with `setDisabled`. A member disabled on its own is not
   * visible here and is not switched on when this goes false — see
   * `FormField.setDisabled`. The second source is a container above this one: a
   * group inside an array inside a form is switched off by any of the three.
   *
   * @type {ReadonlySignal<boolean>}
   */
  disabled;

  /**
   * The path of the first invalid control in declaration order, or the empty
   * string. What a screen focuses after a refused submit — the registry the
   * hand-written version did not have, which is why it was a `querySelector`
   * over an id convention.
   *
   * @type {ReadonlySignal<string>}
   */
  firstInvalid;

  /** @type {ReadonlySignal<string | null>} */
  invalidPath;

  /** @type {readonly (keyof F & string)[]} */
  #names;

  #ownDisabled = signal(false);

  /** @type {Signal<ReadonlySignal<boolean> | null>} */
  #inheritedDisabled = signal(null);

  /** @param {F} fields Declaration order is significant: it is `firstInvalid`'s order. */
  constructor(fields) {
    this.fields = fields;
    this.#names = /** @type {(keyof F & string)[]} */ (Object.keys(fields));
    this.disabled = computed(() => this.#ownDisabled.value || (this.#inheritedDisabled.value?.value ?? false));

    for (const name of this.#names) fields[name]?.inheritDisabled(this.disabled);

    this.valid = computed(() => this.#names.every((name) => fields[name]?.valid.value === true));
    this.dirty = computed(() => this.#names.some((name) => fields[name]?.dirty.value === true));

    this.invalidPath = computed(() => {
      for (const name of this.#names) {
        const below = fields[name]?.invalidPath.value ?? null;
        if (below !== null) return prefix(name, below);
      }
      return null;
    });

    this.firstInvalid = computed(() => this.invalidPath.value ?? '');
  }

  /**
   * Every member's value, by name, all the way down: a field contributes its own
   * value, a nested group an object, an array an array.
   *
   * A getter rather than a signal, because a caller wants this at submit time
   * and a computed one would subscribe every reader to every keystroke.
   *
   * Disabled members are included. Angular drops them; see `FormField` for why a
   * payload that silently loses a column is the worse of the two answers.
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
   * Mark the form submitted, and report whether it may be sent.
   *
   *     if (!this.form.markSubmitted()) return focusFirstInvalid();
   *
   * One call rather than a flag and a check, because the two are never wanted
   * apart: every screen that sets `submitted` does it to make the errors visible
   * for the submit it is about to refuse.
   *
   * @returns {boolean} Whether every control below here is valid.
   */
  markSubmitted() {
    this.submitted.value = true;
    for (const name of this.#names) this.fields[name]?.markSubmitted();
    return this.valid.value;
  }

  /**
   * Apply per-control error codes from a rejected write — the `fields` of a 422.
   *
   * A name may be a path: `email` for a field of this form, `contacts.0.email`
   * for the email of the first row of the `contacts` array. That is the same
   * string `firstInvalid` produces and the same one `<ui-field name>` carries,
   * so a server, a form and a template all address a control the same way.
   *
   * Unknown names are returned rather than dropped, and so are paths naming a
   * *container*: a code against `contacts` describes something no single control
   * can display. A server that reports an error this form cannot place is still
   * describing something the user needs to be told, and silently swallowing it
   * is how a save fails with an empty screen.
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
   * Switch every member off, or back on. What a form calls around a save.
   *
   * @param {boolean} next
   */
  setDisabled(next) {
    this.#ownDisabled.value = next;
  }

  /**
   * The path of the first control carrying a server error, or the empty string.
   *
   * Disabled controls are skipped: their error is not on screen, and the caller
   * is a screen about to focus what it names. Sending focus to a control the
   * user cannot type in is the failure that looks like nothing happening.
   */
  get firstServerError() {
    return this.serverErrorPath ?? '';
  }

  clearServerErrors() {
    for (const name of this.#names) this.fields[name]?.clearServerErrors();
  }

  /**
   * Set values without touching the clean/dirty baseline. What a screen uses to
   * fill in a default the user may still change.
   *
   * Deep: a nested group takes an object, an array takes a list, and a member
   * left out is left alone. An array given a list of a different length changes
   * length — see `FormArray.patch`.
   *
   * @param {Partial<{ [K in keyof F]: PartialValueOf<F[K]> }>} values
   */
  patch(values) {
    for (const [name, value] of Object.entries(values)) {
      if (value !== undefined) this.fields[name]?.fill(value);
    }
  }

  /**
   * Back to a clean state at these values, or at the ones the controls were last
   * clean at. The baseline moves, so a form reset to what the server returned is
   * not dirty — which is what a screen wants after a successful save and before
   * it navigates away.
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
    // `Object.hasOwn` rather than a truthiness check on the lookup: a path of
    // `constructor` or `toString` would otherwise resolve to something off the
    // prototype and be asked to carry a server error.
    if (!Object.hasOwn(this.fields, head)) return null;
    return this.fields[head]?.leafAt(rest) ?? null;
  }

  /**
   * @param {string} _code
   * @returns {boolean} Always false; see `FormArray.setServerError`.
   */
  setServerError(_code) {
    return false;
  }
}

/**
 * A member's answer, seen from its container.
 *
 * The empty string means "the member itself", so the path to it is the member's
 * name; anything else is a path below the member and the name goes in front of
 * it. `FormArray` states the same rule with an index in place of a name.
 *
 * @param {string} name
 * @param {string} below
 * @returns {string}
 */
function prefix(name, below) {
  return below === '' ? name : `${name}.${below}`;
}

/**
 * A form.
 *
 *     const form = group({
 *       name: field('', [required(), maxLength(80)]),
 *       email: field('', [required(), email()]),
 *     });
 *
 * @template {Record<string, FormNode>} F
 * @param {F} fields
 * @returns {FormGroup<F>}
 */
export function group(fields) {
  return new FormGroup(fields);
}
