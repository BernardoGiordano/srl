/**
 * The contract a container needs from whatever it holds, and the recursive value
 * mapping that contract makes possible.
 *
 * The three classes are imported for the mapping alone: `ValueOf` is recursive
 * and conditional, which is the one kind of type JSDoc-in-source cannot express
 * readably. The cycle exists only in the type graph — neither file imports the
 * other at runtime.
 */

import type { ReadonlySignal, Signal } from '@core/foundation/types.js';
import type { FormArray } from '@core/forms/array.js';
import type { FormField } from '@core/forms/field.js';
import type { FormGroup } from '@core/forms/group.js';

/**
 * A rule over one field's value, answering with an error *code* or the empty
 * string. Codes rather than sentences: see `@core/forms/validators.js`.
 *
 * A container takes the same type over its own value, which is what makes
 * `ordered('start', 'end')` a validator and not a second concept.
 */
export type Validator<T> = (value: T) => string;

/**
 * A rule whose answer is somewhere else, which in practice means the server:
 * whether this email address is already registered, whether this code is free.
 *
 * The same shape as `Validator`, plus the signal that aborts a superseded check.
 * A validator that ignores the signal still works and costs one wasted response;
 * one that passes it to `fetch` costs nothing.
 *
 * A rejection is not an invalid value. The field reports no code and lets the
 * write decide, for the reason `resource` does not expose its rejection either:
 * a check that could not run has not found anything wrong.
 */
export type AsyncValidator<T> = (value: T, signal: AbortSignal) => Promise<string>;

/**
 * The lifetime an in-flight asynchronous check is bound to.
 *
 * A function rather than only an `AbortSignal`, because an element's lifetime is
 * a *new* signal after every re-attach. Write `() => this.lifetime` and the field
 * reads the current one per check. Same shape and same reason as
 * `ResourceLifetime`; the two are not one type because `@core/forms` does not
 * import `@core/foundation/resource.js`.
 */
export type FormLifetime = AbortSignal | (() => AbortSignal);

/** What `field()` takes beside its value and its rules. */
export interface FieldOptions<T> {
  /** How two values are compared for `dirty`. Element-wise for arrays by default. */
  equals?: (left: T, right: T) => boolean;

  /** Rules that need a round trip. Run only once every synchronous rule passes. */
  async?: readonly AsyncValidator<T>[];

  /** Milliseconds of quiet before an asynchronous check starts. Defaults to 300. */
  debounce?: number;

  /** Aborts the check in flight when it aborts. `() => this.lifetime` in a component. */
  lifetime?: FormLifetime;
}

/**
 * What a container needs from whatever it holds, so that a group does not know
 * how deep it is.
 *
 * This is the contract nested groups and field arrays are built on, and it is
 * deliberately an *interface* rather than a base class. Angular's
 * `AbstractControl` is a class every control extends, which means every control
 * inherits `updateOn`, the status observables and the async-validator machinery
 * whether or not it uses them. Here there is no inheritance at all: `FormField`,
 * `FormGroup` and `FormArray` are three unrelated classes that happen to answer
 * the same seventeen questions, and a fourth kind of node costs nothing but
 * answering them too.
 *
 * The members below are the *untyped* half of each class. `FormField.snapshot`
 * and `FormField.value.value` are the same value; `snapshot` is what a parent
 * reads when it does not know it is holding a field, `value` is what a screen
 * reads when it does. Same for `fill` beside `setValue`, and for
 * `setServerError` beside the `serverError` signal.
 */
export interface FormNode {
  readonly valid: ReadonlySignal<boolean>;
  readonly dirty: ReadonlySignal<boolean>;
  readonly disabled: ReadonlySignal<boolean>;
  readonly submitted: Signal<boolean>;

  /**
   * Visited at least once. A container's is every member's, and false while it
   * holds none — an empty field array has not been anywhere, and a rule about
   * its length must wait for the submit rather than greet the form.
   *
   * Disabled members are skipped, or a form with one switched-off control would
   * never count as visited and its cross-field error would never appear.
   */
  readonly touched: ReadonlySignal<boolean>;

  /**
   * An asynchronous check is waiting or running below here. True through the
   * debounce window as well as the request, so a submit that waits on this does
   * not slip through the quiet gap between a keystroke and the call it causes.
   *
   * A pending node is not valid: the value is not known to be acceptable yet,
   * and reporting it as valid is how an unchecked value reaches the server.
   */
  readonly pending: ReadonlySignal<boolean>;

  /**
   * The code this node has to show right now, or the empty string — its own
   * error once the timing rule allows it. What `ui-field` and `ui-form-error`
   * render; a container reads its members' `valid`, never this.
   */
  readonly visibleError: ReadonlySignal<string>;

  /** The value here, at whatever depth. A leaf's own, a container's structure. */
  readonly snapshot: unknown;

  /**
   * Where the first invalid leaf is, relative to this node: `''` for this node
   * itself, `'email'` or `'contacts.0.email'` below it, and `null` when there is
   * none.
   *
   * `null` rather than `''` for "none", because a leaf has to be able to say
   * "the invalid one is me" and the empty string is already that answer.
   */
  readonly invalidPath: ReadonlySignal<string | null>;

  /**
   * The same, for a server error, and skipping disabled nodes. A getter rather
   * than a signal: its caller is a submit handler deciding where to put the
   * caret, not a render.
   */
  readonly serverErrorPath: string | null;

  /** Set values without moving the clean/dirty baseline. `patch`, untyped. */
  fill(value: unknown): void;

  /** Back to a clean state, at `next` or at this node's baseline. */
  reset(next?: unknown): void;

  /** Make every error below here visible, and answer whether a submit may go. */
  markSubmitted(): boolean;

  clearServerErrors(): void;

  /** Take a container's disabled state as a second source. */
  inheritDisabled(source: ReadonlySignal<boolean>): void;

  /**
   * The node at this path below here, or null. An empty path is this node.
   * Array segments are decimal indices.
   */
  leafAt(path: readonly string[]): FormNode | null;

  /**
   * Carry the server's code for this node, and report whether it could.
   *
   * A container answers `false`: a 422 naming `contacts` rather than
   * `contacts.0.email` describes something no single control can display, so it
   * is reported to the screen as unmatched instead of being dropped into a field
   * that did not cause it.
   */
  setServerError(code: string): boolean;
}

/**
 * The value shape of a node, all the way down: a field's own type, a group's
 * named structure, an array of its rows'.
 *
 * The mapping is recursive and conditional, which is why this file imports the
 * three classes at the top. The cycle it creates (`field.js` references this
 * file for `Validator`, this file references `field.js` for `FormField`) exists
 * only in the type graph; neither file imports the other at runtime.
 */
export type ValueOf<N> =
  N extends FormField<infer T>
    ? T
    : N extends FormGroup<infer F>
      ? { [K in keyof F]: ValueOf<F[K]> }
      : N extends FormArray<infer C>
        ? ValueOf<C>[]
        : never;

/** A deep `Partial`, which is what `patch` and `reset` accept. */
export type PartialValueOf<N> =
  N extends FormField<infer T>
    ? T
    : N extends FormGroup<infer F>
      ? { [K in keyof F]?: PartialValueOf<F[K]> }
      : N extends FormArray<infer C>
        ? PartialValueOf<C>[]
        : never;

/** One row of a `FormArray`, as a template reads it. */
export interface FormRow<C> {
  /**
   * Stable for the row's lifetime and never reused, so it is what a keyed
   * `*for` tracks: an index would make removing the first row look to lit like
   * every row changing its contents.
   */
  readonly key: string;
  /** Current position. Recomputed on every change, so it is not stable. */
  readonly index: number;
  readonly control: C;
}

/**
 * A literal type widened to its base.
 *
 * `field('')` infers `''` for its type parameter, because that is what TypeScript
 * does with a literal argument in a generic position, and a field that can only
 * ever hold the empty string is not a field. `let x = ''` widens; inference does
 * not, so it is done here.
 */
export type Widened<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T;
