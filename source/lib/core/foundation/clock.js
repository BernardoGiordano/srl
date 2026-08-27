/**
 * The one seam between a scheduled callback and the wall clock.
 *
 * Three components debounce: the table persists its column configuration, the
 * sidebar persists its collapsed state, the dynamic filter holds a typeahead back
 * until the keystrokes stop. All three called `setTimeout` directly, and a suite
 * that wanted to see the far side of a debounce had one move available — sleep
 * past it. So `table.test.js` slept 400 real milliseconds to prove a flushed timer
 * does not fire twice, and `ui-dynamic-filter.js` exported its debounce constant
 * for no reason other than a test's arithmetic. A production module exporting a
 * number so a suite can add twenty to it is the shape of a missing seam.
 *
 * The seam is the same one `configurePreferences({ storage })` is: one module
 * owns the boundary, the default is the browser's, and an application or a suite
 * may hand over another implementation. ADR-0079, ADR-0015.
 *
 * `schedule` returns the call that cancels it, rather than a handle to pass back.
 * A handle would have to be interpreted by whichever clock is installed *now*,
 * which is not necessarily the one that issued it; a closure cannot be given to
 * the wrong clock.
 */

/** @import { Clock, ClockConfig, ManualClock } from '@core/foundation/types.js' */

/** @type {Clock | undefined} */
let configured;

/** Real timers, and what every consumer gets until an application says otherwise. */
/** @type {Clock} */
const REAL_TIMERS = {
  schedule(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    return () => clearTimeout(handle);
  },
};

/**
 * Change the clock every scheduled callback in the library goes through. Calling
 * with no args restores real timers.
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
 * How many callbacks one `flush()` will run before deciding it is not draining.
 * A callback that schedules its own successor would otherwise flush forever.
 */
const FLUSH_LIMIT = 1000;

/**
 * A clock a test drives by hand, and the second implementation that makes the
 * seam above real rather than notional.
 *
 * It exposes exactly what the suites need and no more. `flush()` runs everything
 * waiting, in the order it came due; `pending` is how many callbacks are waiting.
 * There is deliberately no `advance(ms)`: reaching a point "just before" a
 * debounce means knowing its length, and a suite knowing that number is the
 * export this module exists to delete.
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
