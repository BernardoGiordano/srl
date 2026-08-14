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
 */
export type Validator<T> = (value: T) => string;

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
 * the same fourteen questions, and a fourth kind of node costs nothing but
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
