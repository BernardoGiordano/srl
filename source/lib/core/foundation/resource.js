import { batch, signal, untracked } from '@core/foundation/reactive.js';

/**
 * One asynchronous read whose latest call wins.
 *
 *     #orders = resource(
 *       (signal) => inject(SALES_SERVICE).searchOrders(this.#query, signal),
 *       { initial: { rows: [], total: 0 }, lifetime: () => this.lifetime },
 *     );
 *
 *     rows = computed(() => this.#orders.value.value.rows);
 *
 * WHAT IT OWNS
 *
 *  - **Supersession.** `reload()` aborts the request in flight, and a response that
 *    arrives for an aborted one is dropped rather than written. Without that the
 *    slowest response wins and the screen shows a page nobody asked for.
 *  - **The two flags a screen binds.** `pending` is "nothing has settled yet, or a
 *    request is in flight"; `failed` is "the last request that was not superseded
 *    rejected", cleared when the next one starts, which is what makes a retry
 *    button one call. `pending` starts true because a component's first paint
 *    happens before its `onMount`.
 *  - **The lifetime.** The request aborts when the owner's does, so `onDestroy` has
 *    nothing to write. ADR-0076.
 *
 * WHAT IT DOES NOT
 *
 * It does not re-run itself when a signal the loader read changes: a table emits one
 * `query-change` for a page, size, sort and filter change at once, and an
 * auto-tracking resource would fire four. The loader runs untracked, which is what
 * makes `reload()` safe to call from inside an `effect` — a detail screen reloads
 * from one over `routeParams`, and every signal the loader touched would otherwise
 * become a dependency of that effect.
 *
 * It does not expose the rejection. A screen that needs the server's error code
 * catches inside its own loader and returns a value carrying it, which keeps
 * `ApiError` out of an interface every other screen would have to narrow.
 *
 * It does not cache, key or dedupe by request: this is the primitive under a store,
 * not one.
 */

/** @import { ReadonlySignal } from '@core/foundation/types.js' */

/**
 * @template T
 * @typedef {object} Resource
 * @property {ReadonlySignal<T>} value The last settled value, or `initial` until one settles. A superseded or failed request leaves it alone.
 * @property {ReadonlySignal<boolean>} pending Whether a request is in flight, or none has settled yet. True until the first one does.
 * @property {ReadonlySignal<boolean>} failed Whether the last request that was neither superseded nor aborted rejected.
 * @property {() => Promise<T | undefined>} reload Start a request, aborting any in flight. Resolves with the value, or `undefined` when the request was superseded, aborted or rejected.
 */

/**
 * The lifetime an in-flight request is bound to.
 *
 * A function rather than only an `AbortSignal`, because an element's lifetime is a
 * *new* `AbortSignal` after every re-attach: `SignalElement` aborts and drops its
 * controller on disconnect, so a resource built in a field initialiser that had
 * captured `this.lifetime` would hold an already-aborted signal for the rest of the
 * element's life, and every reload after a DOM move would abort before it was sent.
 * Write `() => this.lifetime` and the resource reads the current one per request.
 *
 * @typedef {AbortSignal | (() => AbortSignal)} ResourceLifetime
 */

/**
 * @template T
 * @typedef {object} ResourceOptions
 * @property {T} initial What `value` holds before the first request settles. Required: a screen binds `value` from its first render, and an interface whose value is `T | undefined` makes every template carry the empty case twice.
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

    // Nothing is listening any more: not sending is the same answer as sending
    // and dropping the response, one request cheaper.
    if (lifetime?.aborted === true) return undefined;

    current?.abort();
    const request = new AbortController();
    current = request;

    // Bound to `request.signal`, so the listener is removed when this request
    // ends rather than accumulating one per reload on a lifetime that outlives
    // all of them.
    lifetime?.addEventListener('abort', () => request.abort(lifetime.reason), {
      once: true,
      signal: request.signal,
    });

    batch(() => {
      pending.value = true;
      failed.value = false;
    });

    try {
      const next = await untracked(() => load(request.signal));

      // Superseded, or the owner went away. The request that replaced this one
      // owns `pending` now, so this one writes nothing at all.
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
      if (current === request) current = undefined;
    }
  }

  return { value, pending, failed, reload };
}
