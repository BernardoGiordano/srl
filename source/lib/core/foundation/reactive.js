/**
 * The reactive primitives, and the only import of the signal library.
 *
 * Nothing else imports `@preact/signals-core`, so replacing it, with TC39 Signals or
 * alien-signals for example, changes this file alone.
 *
 * The API follows Angular's `signal`, `computed`, `effect` and `untracked`, with one
 * difference. You read a signal with `.value`, not by calling it. `count()` is a
 * TypeError, and `if (count)` is always true because a signal is an object. tsc catches
 * the first mistake but not the second, so write `if (count.value)`.
 */

export { batch, computed, effect, signal, untracked } from '@preact/signals-core';

/**
 * The signal base class, for `instanceof` checks. `@core/template/expression.js` uses
 * it to unwrap signals, so `{{ users }}` works without `.value`.
 */
export { Signal } from '@preact/signals-core';

/**
 * Read a signal without subscribing to it.
 *
 * @template T
 * @param {import('@core/foundation/types.js').ReadonlySignal<T>} source
 * @returns {T}
 */
export function peek(source) {
  return source.peek();
}
