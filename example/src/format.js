import { rel } from '@core/localization/i18n.js';

/**
 * "Three minutes ago", from a timestamp.
 *
 * `rel()` in `@core/localization/i18n.js` is `Intl.RelativeTimeFormat` with the locale and
 * the memoisation already handled, and it takes what that API takes: a signed number and a
 * unit. Choosing the unit is the caller's problem, and six screens here had the same
 * caller's problem, so it is solved once.
 *
 * Deliberately not in the framework. Which unit reads best is a product decision — a
 * dashboard wants "2 minutes ago" where an HR record wants "3 years ago" — and a library
 * that picked for everybody would be wrong for somebody. What the library owes is the
 * formatting and the locale, which is what it provides.
 *
 * @param {string | number | Date} when An ISO string, epoch milliseconds, or a Date.
 * @param {Intl.RelativeTimeFormatUnit} [unit] Force a unit instead of choosing one.
 * @returns {string} The empty string for an unparseable input, because a broken timestamp
 *   should leave a gap rather than render "Invalid Date" on a screen.
 */
export function ago(when, unit) {
  const at = when instanceof Date ? when.getTime() : new Date(when).getTime();
  if (Number.isNaN(at)) return '';

  const seconds = (at - Date.now()) / 1000;

  if (unit !== undefined) return rel(Math.round(seconds / secondsIn(unit)), unit);

  // Largest unit whose magnitude is at least one, so "90 minutes ago" becomes "2 hours
  // ago" rather than staying in minutes forever. `Math.round` on the way out: the
  // formatter's own rounding would show "1.5 hours".
  for (const [candidate, size] of UNITS) {
    if (Math.abs(seconds) >= size) return rel(Math.round(seconds / size), candidate);
  }
  return rel(Math.round(seconds), 'second');
}

/**
 * Seconds per unit, largest first, which is also the order the scan above wants. Months and
 * years are the average lengths `Intl` itself assumes for a relative statement: nobody
 * reading "2 months ago" is counting days.
 *
 * A tuple list rather than a record, because `noUncheckedIndexedAccess` makes every lookup
 * in a record `number | undefined` and there is nothing useful to do with the undefined
 * branch of a table this module owns.
 *
 * @type {ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]>}
 */
const UNITS = [
  ['year', 31_557_600],
  ['quarter', 7_889_400],
  ['month', 2_629_800],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
  ['second', 1],
];

/**
 * @param {Intl.RelativeTimeFormatUnit} unit
 * @returns {number}
 */
function secondsIn(unit) {
  // The plural forms are the same unit: `Intl` accepts both, and a caller asking for
  // 'years' should not fall through to seconds.
  const singular = unit.endsWith('s') ? unit.slice(0, -1) : unit;
  return UNITS.find(([name]) => name === singular)?.[1] ?? 1;
}
