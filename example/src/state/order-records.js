import { token } from '@core/foundation/inject.js';
import { computed, effect, signal, untracked } from '@core/foundation/reactive.js';
import { resource } from '@core/foundation/resource.js';

/** @import { ReadonlySignal } from '@core/foundation/types.js' */
/** @import { Customer, Order } from '../services/sales-service.js' */

/**
 * @typedef {Order & { customerDetail: Customer | null }} OrderDetail
 */

/**
 * Operations this module needs from the sales service.
 *
 * @typedef {object} OrderSource
 * @property {(id: string, signal: AbortSignal) => Promise<OrderDetail>} order
 * @property {(id: string, status: string) => Promise<Order>} setOrderStatus
 */

/**
 * One shared view of whichever order a caller is watching.
 *
 * @typedef {object} OrderRecord
 * @property {ReadonlySignal<OrderDetail | null>} value
 * @property {ReadonlySignal<boolean>} pending
 * @property {ReadonlySignal<boolean>} failed
 * @property {() => Promise<OrderDetail | null | undefined>} reload
 * @property {(status: string) => Promise<OrderDetail | null | undefined>} setStatus
 */

/**
 * One shared entry. Each watcher receives its own lease.
 *
 * @typedef {object} OrderLease
 * @property {string} id
 * @property {ReadonlySignal<OrderDetail | null>} value
 * @property {ReadonlySignal<boolean>} pending
 * @property {ReadonlySignal<boolean>} failed
 * @property {() => Promise<OrderDetail | null | undefined>} reload
 * @property {(status: string) => Promise<OrderDetail | null | undefined>} setStatus
 * @property {() => void} release
 */

/**
 * @typedef {object} OrderEntry
 * @property {string} id
 * @property {ReturnType<typeof resource<OrderDetail | null>>} read
 * @property {AbortController} lifetime
 * @property {number} retained
 */

/** @type {import('@core/foundation/types.js').InjectionToken<OrderRecords>} */
export const ORDER_RECORDS = token('OrderRecords');

/**
 * Share one order request among mounted readers of the same id. A status write
 * refreshes their shared value. The last reader releases the entry, so a later
 * visit fetches it again.
 */
export class OrderRecords {
  #source;

  /** @type {Map<string, OrderEntry>} */
  #records = new Map();

  /** @param {OrderSource} source */
  constructor(source) {
    this.#source = source;
  }

  /**
   * Follow an id until `lifetime` ends. Read the id on each update because the
   * router may reuse the element for another order.
   *
   * @param {() => string} readId
   * @param {AbortSignal} lifetime
   * @returns {OrderRecord}
   */
  watch(readId, lifetime) {
    if (lifetime.aborted) {
      throw new Error('Cannot watch an order with an already-aborted lifetime.');
    }

    const current = signal(/** @type {OrderLease | null} */ (null));

    const stop = effect(() => {
      const id = readId();
      const previous = untracked(() => current.value);
      if (previous?.id === id || (previous === null && id === '')) return;

      previous?.release();
      current.value = id === '' ? null : this.#retain(id);
    });

    const release = () => {
      stop();
      untracked(() => current.value)?.release();
      current.value = null;
    };
    lifetime.addEventListener('abort', release, { once: true });

    return {
      value: computed(() => current.value?.value.value ?? null),
      pending: computed(() => current.value?.pending.value ?? true),
      failed: computed(() => current.value?.failed.value ?? false),
      reload: async () => untracked(() => current.value)?.reload(),
      setStatus: async (status) => untracked(() => current.value)?.setStatus(status),
    };
  }

  /**
   * Retain one keyed resource and return an idempotent release function.
   *
   * @param {string} id
   * @returns {OrderLease}
   */
  #retain(id) {
    let entry = this.#records.get(id);
    if (entry === undefined) {
      const lifetime = new AbortController();
      entry = {
        id,
        lifetime,
        retained: 0,
        read: resource((signal) => this.#source.order(id, signal), {
          initial: /** @type {OrderDetail | null} */ (null),
          lifetime: lifetime.signal,
        }),
      };
      this.#records.set(id, entry);
    }

    entry.retained += 1;
    if (entry.retained === 1) void entry.read.reload();

    let released = false;
    return {
      id,
      value: entry.read.value,
      pending: entry.read.pending,
      failed: entry.read.failed,
      reload: () => entry.read.reload(),
      setStatus: async (status) => {
        await this.#source.setOrderStatus(id, status);
        return entry.read.reload();
      },
      release: () => {
        if (released) return;
        released = true;
        this.#release(entry);
      },
    };
  }

  /**
   * @param {OrderEntry} entry
   */
  #release(entry) {
    entry.retained -= 1;
    if (entry.retained > 0) return;

    // Remove the entry before abort handlers run so new watchers fetch afresh.
    this.#records.delete(entry.id);
    entry.lifetime.abort();
  }
}
