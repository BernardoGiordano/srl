/**
 * The reactive primitives, and the single seam between this application and the
 * signal library underneath it.
 *
 * Nothing else in the codebase imports '@preact/signals-core'. Replacing it with
 * TC39 Signals when the proposal ships (Stage 1 as of mid-2026, so this is a
 * when-not-if with an unknown date), or with alien-signals for raw speed, or
 * with @vue/reactivity for deep object proxies, is a change to this file and
 * nothing else. For a codebase meant to last five years that seam is worth the
 * one indirection.
 *
 * The API is deliberately the Angular one. `signal`, `computed`, `effect` and
 * `untracked` behave as they do in Angular 17+, with one difference that bites
 * every Angular developer exactly once: you read a signal with `.value`, not by
 * calling it. `count()` is a TypeError here, and `if (count)` is always true
 * because a signal is an object. tsc catches the first; nothing catches the
 * second, so prefer `if (count.value)`.
 */

export { batch, computed, effect, signal, untracked } from '@preact/signals-core';

/**
 * The signal base class, re-exported for `instanceof` checks.
 *
 * One consumer: `@core/template/expression.js`, which auto-unwraps signals read from a
 * template so `{{ users }}` does not have to be written `{{ users.value }}`.
 * Deciding "is this a signal" needs the class, and this file remains the only
 * place allowed to name the library.
 */
export { Signal } from '@preact/signals-core';

/**
 * Read a signal without subscribing. Angular's `signal.peek()` under a name
 * that says what it costs you.
 *
 * @template T
 * @param {import('@core/foundation/types.js').ReadonlySignal<T>} source
 * @returns {T}
 */
export function peek(source) {
  return source.peek();
}
