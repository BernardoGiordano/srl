/**
 * The seam between scheduled callbacks and the wall clock. ADR-0079.
 *
 * Components that debounce schedule through here, so tests can install a manual clock
 * instead of sleeping. It works like `configurePreferences({ storage })` (ADR-0015).
 * The default is the browser's timers, and an application or a test may install
 * another clock.
 *
 * `schedule` returns a cancel function instead of a handle, so a cancel always reaches
 * the clock that scheduled the callback.
 */

/** @import { Clock, ClockConfig, ManualClock } from '@core/foundation/types.js' */

/** @type {Clock | undefined} */
let configured;

/** Real timers, used until an application installs another clock. */
/** @type {Clock} */
const REAL_TIMERS = {
  schedule(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    return () => clearTimeout(handle);
  },
};

/**
 * Replace the clock every scheduled callback in the library uses. Call it with no
 * argument to restore real timers.
 *
 * @param {ClockConfig} [config]
 */
export function configureClock(config = {}) {
  configured = config.clock;
}

/**
 * Run `callback` no sooner than `delayMs` from now.
 *
 * @param {() => void} callback
 * @param {number} delayMs
 * @returns {() => void} cancels it, and is safe to call after it has run
 */
export function schedule(callback, delayMs) {
  return (configured ?? REAL_TIMERS).schedule(callback, delayMs);
}

/**
 * How many callbacks one `flush()` runs before it gives up. A callback that schedules
 * its own successor would otherwise flush forever.
 */
const FLUSH_LIMIT = 1000;

/**
 * A clock a test drives by hand.
 *
 * `flush()` runs everything waiting, in due order, and `pending` counts the waiting
 * callbacks. There's no `advance(ms)`, because a test that knows a debounce length is
 * coupled to it.
 *
 * @returns {ManualClock}
 */
export function createManualClock() {
  /** @type {Map<number, { callback: () => void, dueAt: number, order: number }>} */
  const waiting = new Map();
  let nextId = 0;
  let now = 0;

  /** The entry that comes due first, ties broken by the order it was scheduled in. */
  function earliest() {
    /** @type {{ id: number, entry: { callback: () => void, dueAt: number, order: number } } | undefined} */
    let found;
    for (const [id, entry] of waiting) {
      if (
        found === undefined ||
        entry.dueAt < found.entry.dueAt ||
        (entry.dueAt === found.entry.dueAt && entry.order < found.entry.order)
      ) {
        found = { id, entry };
      }
    }
    return found;
  }

  return {
    schedule(callback, delayMs) {
      const id = (nextId += 1);
      waiting.set(id, { callback, dueAt: now + Math.max(0, delayMs), order: id });
      return () => void waiting.delete(id);
    },

    get pending() {
      return waiting.size;
    },

    flush() {
      for (let fired = 0; fired < FLUSH_LIMIT; fired += 1) {
        const next = earliest();
        if (next === undefined) return;
        waiting.delete(next.id);
        now = next.entry.dueAt;
        next.entry.callback();
      }
      throw new Error(
        `A manual clock ran ${FLUSH_LIMIT} callbacks and was still not empty. Something it ` +
          `fired schedules its own successor, so there is no state in which it has drained.`,
      );
    },
  };
}
