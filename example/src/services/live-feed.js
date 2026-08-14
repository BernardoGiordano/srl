import { token } from '@core/foundation/inject.js';
import { signal } from '@core/foundation/reactive.js';

/** @import { ApiClient } from '@core/http/client.js' */
/** @import { Movement } from './inventory-service.js' */

/**
 * The live event stream, as signals.
 *
 * `EventSource` is a callback API and the rest of this application is reactive, so
 * exactly one place bridges the two: the handlers below write signals, and every
 * screen that shows live data reads them and subscribes by doing so. No component
 * adds a listener, and no component has to remove one.
 *
 * WHY A REFERENCE COUNT
 *
 * A screen calls `retain()` on mount and the returned function on destroy; the socket
 * opens on the first retain and closes on the last release, so two screens open at
 * once share one connection.
 *
 * Reconnection is the browser's: `EventSource` retries on its own, honouring the
 * `retry:` hint the server sends, and `connected` follows the result so a screen can
 * say so.
 */

/** @type {import('@core/foundation/types.js').InjectionToken<LiveFeed>} */
export const LIVE_FEED = token('LiveFeed');

/** How many movements to keep. A ticker, not a log: the table beside it is the log. */
const WINDOW = 12;

/**
 * @typedef {Movement & { name: string, stock: number, belowReorder: boolean }} StockEvent
 */

/**
 * @typedef {object} OrderStatusEvent
 * @property {string} id
 * @property {string} code
 * @property {string} status
 * @property {string} actor
 */

export class LiveFeed {
  /** Whether the stream is currently open. */
  connected = signal(false);

  /** Most recent stock movements, newest first, capped at `WINDOW`. */
  movements = signal(/** @type {readonly StockEvent[]} */ ([]));

  /** The last order status change seen, or null. */
  lastOrderChange = signal(/** @type {OrderStatusEvent | null} */ (null));

  /** Total events received since the connection first opened. */
  received = signal(0);

  #client;
  /** @type {EventSource | undefined} */
  #source;
  #retained = 0;

  /** @param {ApiClient} client */
  constructor(client) {
    this.#client = client;
  }

  /**
   * Open the stream if it is not open, and keep it open until the returned function
   * is called. Safe to call from `onMount` and to discard in `onDestroy`.
   *
   * @returns {() => void}
   */
  retain() {
    this.#retained += 1;
    if (this.#retained === 1) this.#open();

    let released = false;
    return () => {
      // Idempotent: a component that releases twice must not close a connection
      // another screen is still holding.
      if (released) return;
      released = true;
      this.#retained -= 1;
      if (this.#retained === 0) this.#close();
    };
  }

  #open() {
    if (this.#source !== undefined) return;

    // No token in the URL. The stream authenticates with the same HttpOnly cookie
    // every other request uses, which is the one thing `EventSource` — a GET with
    // no way to set a header — makes easy under the `bff` strategy and awkward
    // under a bearer-token one.
    const source = new EventSource(this.#client.streamUrl('/events'), { withCredentials: true });
    this.#source = source;

    source.onopen = () => {
      this.connected.value = true;
    };

    source.onerror = () => {
      // Not a failure by itself: the browser reports the drop and then reconnects.
      // A screen shows "reconnecting", which is the truth, rather than an error.
      this.connected.value = false;
    };

    source.addEventListener('stock.movement', (event) => {
      const movement = parse(event);
      if (movement === null) return;
      this.movements.value = [/** @type {StockEvent} */ (movement), ...this.movements.value].slice(0, WINDOW);
      this.received.value += 1;
    });

    source.addEventListener('order.status', (event) => {
      const change = parse(event);
      if (change === null) return;
      this.lastOrderChange.value = /** @type {OrderStatusEvent} */ (change);
      this.received.value += 1;
    });
  }

  #close() {
    this.#source?.close();
    this.#source = undefined;
    this.connected.value = false;
  }
}

/**
 * Anything on the origin can be the source of a frame, so the payload is parsed
 * defensively rather than trusted. A malformed frame is dropped, not thrown: one bad
 * event must not stop the stream.
 *
 * @param {Event} event
 * @returns {Record<string, unknown> | null}
 */
function parse(event) {
  const data = /** @type {MessageEvent<unknown>} */ (event).data;
  if (typeof data !== 'string') return null;
  try {
    const parsed = /** @type {unknown} */ (JSON.parse(data));
    return typeof parsed === 'object' && parsed !== null ? /** @type {Record<string, unknown>} */ (parsed) : null;
  } catch {
    return null;
  }
}
