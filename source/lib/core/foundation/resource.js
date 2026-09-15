import { batch, signal, untracked } from '@core/foundation/reactive.js';

/**
 * One asynchronous read whose latest call wins. ADR-0076.
 *
 *     #orders = resource(
 *       (signal) => inject(SALES_SERVICE).searchOrders(this.#query, signal),
 *       { initial: { rows: [], total: 0 }, lifetime: () => this.lifetime },
 *     );
 *
 *     rows = computed(() => this.#orders.value.value.rows);
 *
 * - `reload()` aborts the request in flight and drops any response for an aborted
 *   request, so the slowest response can't win.
 * - `pending` is true until a request settles and while one is in flight. It starts
 *   true, because a component paints before `onMount`.
 * - `failed` reports that the last unsuperseded request rejected. It clears when the
 *   next request starts, so a retry button is one call.
 * - The request aborts with its owner's lifetime, and every path removes the owner
 *   listener.
 *
 * The loader runs untracked. A resource doesn't re-run when a signal the loader read
 * changes, and calling `reload()` inside an `effect` adds no dependencies to it.
 *
 * Rejections aren't exposed. A screen that needs an error code catches inside its loader
 * and returns a value carrying it. The resource doesn't cache, key or dedupe.
 */

/** @import { ReadonlySignal } from '@core/foundation/types.js' */

/**
 * @template T
 * @typedef {object} Resource
 * @property {ReadonlySignal<T>} value The last settled value, or `initial` until one settles. Superseded and failed requests leave it unchanged.
 * @property {ReadonlySignal<boolean>} pending Whether a request is in flight, or none has settled yet.
 * @property {ReadonlySignal<boolean>} failed Whether the last request that was neither superseded nor aborted rejected.
 * @property {() => Promise<T | undefined>} reload Start a request, aborting any in flight. Resolves with the value, or `undefined` when superseded, aborted or rejected.
 */

/**
 * The lifetime a request is bound to.
 *
 * Pass `() => this.lifetime` in a component. `SignalElement` replaces its lifetime
 * signal after a disconnect, so a captured signal would already be aborted once the
 * element moves.
 *
 * @typedef {AbortSignal | (() => AbortSignal)} ResourceLifetime
 */

/**
 * @template T
 * @typedef {object} ResourceOptions
 * @property {T} initial What `value` holds before the first request settles. Required, so templates never handle `undefined`.
 * @property {ResourceLifetime} [lifetime] Aborts the in-flight request when it aborts. `() => this.lifetime` in a component.
 */

/**
 * Build a resource.
 *
 * @template T
 * @param {(signal: AbortSignal) => Promise<T>} load Issues the request. Receives the signal to pass to `fetch`, an `ApiClient` call or a service.
 * @param {ResourceOptions<T>} options
 * @returns {Resource<T>}
 */
export function resource(load, options) {
  const value = signal(options.initial);
  const pending = signal(true);
  const failed = signal(false);

  /** The request whose result is still wanted. Anything else is superseded. */
  /** @type {AbortController | undefined} */
  let current;

  /** @returns {Promise<T | undefined>} */
  async function reload() {
    const lifetime =
      typeof options.lifetime === 'function' ? options.lifetime() : options.lifetime;

    // The owner is gone, so skip the request.
    if (lifetime?.aborted === true) return undefined;

    current?.abort();
    const request = new AbortController();
    current = request;

    const abortWithOwner = () => request.abort(lifetime?.reason);

    // `signal: request.signal` removes the listener when the request is superseded, and
    // `finally` removes it when the request settles.
    lifetime?.addEventListener('abort', abortWithOwner, {
      once: true,
      signal: request.signal,
    });

    batch(() => {
      pending.value = true;
      failed.value = false;
    });

    try {
      const next = await untracked(() => load(request.signal));

      // Superseded or abandoned. The newer request owns `pending`, so write nothing.
      if (request.signal.aborted) return undefined;

      batch(() => {
        value.value = next;
        pending.value = false;
      });
      return next;
    } catch {
      if (request.signal.aborted) return undefined;

      batch(() => {
        failed.value = true;
        pending.value = false;
      });
      return undefined;
    } finally {
      lifetime?.removeEventListener('abort', abortWithOwner);
      if (current === request) current = undefined;
    }
  }

  return { value, pending, failed, reload };
}
