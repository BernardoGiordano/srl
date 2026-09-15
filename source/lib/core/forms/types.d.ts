/**
 * The contract containers need from their members, and the recursive value types it
 * enables.
 *
 * The three classes are imported only for `ValueOf`, a recursive conditional type
 * that JSDoc can't express readably. The import cycle exists only in types.
 */

import type { ReadonlySignal, Signal } from '@core/foundation/types.js';
import type { FormArray } from '@core/forms/array.js';
import type { FormField } from '@core/forms/field.js';
import type { FormGroup } from '@core/forms/group.js';

/**
 * A rule over a value that returns an error code, or the empty string when valid.
 * Containers use the same type over their own value, as in `ordered('start', 'end')`.
 */
export type Validator<T> = (value: T) => string;

/**
 * A rule answered elsewhere, usually by the server, such as whether an email is
 * already registered.
 *
 * Pass the signal to `fetch` so a superseded check aborts. A rejection isn't an
 * invalid value. The field reports no code and lets the write decide.
 */
export type AsyncValidator<T> = (value: T, signal: AbortSignal) => Promise<string>;

/**
 * The lifetime an asynchronous check is bound to. Pass `() => this.lifetime` in a
 * component, because an element gets a new lifetime signal after every re-attach.
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
 * What a container needs from its members, so a group doesn't care how deep it is.
 *
 * This is an interface, where Angular's `AbstractControl` is a base class.
 * `FormField`, `FormGroup` and `FormArray` are unrelated classes that answer the same
 * questions, and a new kind of node only has to answer them too.
 *
 * Members here are the untyped side of each class. `snapshot` mirrors
 * `FormField.value.value`, `fill` mirrors `setValue`, and `setServerError` mirrors the
 * `serverError` signal.
 */
export interface FormNode {
  readonly valid: ReadonlySignal<boolean>;
  readonly dirty: ReadonlySignal<boolean>;
  readonly disabled: ReadonlySignal<boolean>;
  readonly submitted: Signal<boolean>;

  /**
   * True once visited. A container is visited when every member is, and an empty
   * container is not. Disabled members are skipped.
   */
  readonly touched: ReadonlySignal<boolean>;

  /**
   * True while an asynchronous check below here waits or runs, including the debounce.
   * A pending node isn't valid.
   */
  readonly pending: ReadonlySignal<boolean>;

  /**
   * The code to show now, or the empty string. `ui-field` and `ui-form-error` render
   * it, and containers read `valid` instead.
   */
  readonly visibleError: ReadonlySignal<string>;

  /** The value here. A leaf returns its own, and a container returns its structure. */
  readonly snapshot: unknown;

  /**
   * The path to the first invalid leaf, relative to this node. `''` means this node,
   * `'contacts.0.email'` means a node below, and `null` means none.
   */
  readonly invalidPath: ReadonlySignal<string | null>;

  /**
   * The same, for server errors, skipping disabled nodes. A getter, because a submit
   * handler reads it once.
   */
  readonly serverErrorPath: string | null;

  /** Set values without moving the clean baseline, like an untyped `patch`. */
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
   * Carry the server's code for this node, and report whether it could. Containers
   * return `false`, so a 422 naming `contacts` comes back unmatched.
   */
  setServerError(code: string): boolean;
}

/**
 * The value shape of a node, all the way down. A field gives its type, a group a named
 * structure and an array a list.
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
   * Stable for the row's lifetime and never reused. Keyed `*for` tracks it, since an
   * index would make removing the first row look like every row changing.
   */
  readonly key: string;
  /** Current position. It changes when rows above it change. */
  readonly index: number;
  readonly control: C;
}

/**
 * A literal type widened to its base. `field('')` would otherwise infer `''`, and a
 * field that can only hold the empty string is useless.
 */
export type Widened<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T;
