import { effect, peek } from '@core/foundation/reactive.js';

/** @import { ReadonlySignal } from '@core/foundation/types.js' */

/**
 * Resolve once nothing below a node is pending. A submit handler awaits it, which
 * keeps `markSubmitted()` synchronous.
 *
 *     await this.form.whenSettled();
 *     if (!this.form.markSubmitted()) return void focusInvalidField(this, this.form);
 *
 * An already settled node resolves on a microtask. An edit after resolution makes the
 * node pending again.
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
      // An effect can't dispose itself during its body, and `stop` isn't assigned
      // during the first run, so dispose on a microtask.
      queueMicrotask(() => stop());
    });
  });
}
