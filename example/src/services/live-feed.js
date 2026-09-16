import { token } from '@core/foundation/inject.js';
import { signal } from '@core/foundation/reactive.js';

/** @import { ApiClient } from '@core/http/client.js' */
/** @import { Movement } from './inventory-service.js' */

/**
 * Publish SSE events as signals. Screens share one connection by calling `retain()`
 * on mount and releasing it on destroy. `EventSource` handles reconnects; the
 * `connected` signal lets screens show the current state.
 */

/** @type {import('@core/foundation/types.js').InjectionToken<LiveFeed>} */
export const LIVE_FEED = token('LiveFeed');

/** Recent movements to keep in the ticker. */
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
   * Keep the stream open until the returned release function runs.
   *
   * @returns {() => void}
   */
  retain() {
    this.#retained += 1;
    if (this.#retained === 1) this.#open();

    let released = false;
    return () => {
      // A second release must not close another screen's connection.
      if (released) return;
      released = true;
      this.#retained -= 1;
      if (this.#retained === 0) this.#close();
    };
  }

  #open() {
    if (this.#source !== undefined) return;

    // The browser sends the session cookie with the event stream.
    const source = new EventSource(this.#client.streamUrl('/events'), { withCredentials: true });
    this.#source = source;

    source.onopen = () => {
      this.connected.value = true;
    };

    source.onerror = () => {
      // EventSource reconnects after a drop.
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
 * Drop malformed frames without stopping the stream.
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
