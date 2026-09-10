import { effect, peek } from '@core/foundation/reactive.js';

/** @import { ReadonlySignal } from '@core/foundation/types.js' */

/**
 * Resolve once nothing below a node is pending.
 *
 * The one thing a submit handler needs from asynchronous validation, and the
 * reason `markSubmitted()` stays synchronous: a screen awaits this, then asks the
 * question it always asked.
 *
 *     await this.form.whenSettled();
 *     if (!this.form.markSubmitted()) return void focusInvalidField(this, this.form);
 *
 * Already settled resolves on a microtask rather than synchronously, which is
 * what every `await` does anyway and what keeps the two branches the same shape.
 *
 * A value edited again after this resolves is pending again. The promise answers
 * for the moment it settled, not for the rest of the form's life.
 *
 * @param {ReadonlySignal<boolean>} pending
 * @returns {Promise<void>}
 */
export function whenSettled(pending) {
  if (!peek(pending)) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = effect(() => {
      if (pending.value) return;
      resolve();
      // Disposing from inside the body is not allowed, and `stop` is still in its
      // temporal dead zone during the first synchronous run. The microtask is
      // after both.
      queueMicrotask(() => stop());
    });
  });
}
