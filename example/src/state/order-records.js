import { token } from '@core/foundation/inject.js';
import { computed, effect, signal, untracked } from '@core/foundation/reactive.js';
import { resource } from '@core/foundation/resource.js';

/** @import { ReadonlySignal } from '@core/foundation/types.js' */
/** @import { Customer, Order } from '../services/sales-service.js' */

/**
 * @typedef {Order & { customerDetail: Customer | null }} OrderDetail
 */

/**
 * The two operations this state module needs from the sales transport adapter.
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
 * One retained entry, internal to the module. A separate lease is returned for
 * every watcher so releasing one cannot release another.
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
 * Shared settled order records, owned for exactly as long as a mounted reader.
 *
 * `watch()` is the whole interface a screen needs. It follows the supplied id,
 * joins every reader of that id to one resource, refreshes that shared value
 * after a status write, and releases it when the caller's lifetime ends. There
 * is no staleness interval or retained cache: the final reader leaving deletes
 * the entry, so a later visit asks the server again.
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
   * Follow one record id until `lifetime` ends.
   *
   * The id is a function because a router reuses the same elements when only a
   * path parameter changes. The watcher moves its lease in that same update, so
   * callers do not coordinate release, reload, or stale values themselves.
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
   * Retain one keyed resource, starting its first read when the first watcher
   * arrives. Every returned release is idempotent and owns one retain only.
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

    // Delete first. A watcher arriving while abort handlers run must build a
    // fresh entry, not join one whose request is already being abandoned.
    this.#records.delete(entry.id);
    entry.lifetime.abort();
  }
}
