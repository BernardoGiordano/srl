import { rel } from '@core/localization/i18n.js';

/**
 * Format a timestamp as relative time. The application chooses a unit and delegates
 * locale-aware wording to `rel()`.
 *
 * @param {string | number | Date} when An ISO string, epoch milliseconds, or a Date.
 * @param {Intl.RelativeTimeFormatUnit} [unit] Force a unit instead of choosing one.
 * @returns {string} An empty string for an invalid timestamp.
 */
export function ago(when, unit) {
  const at = when instanceof Date ? when.getTime() : new Date(when).getTime();
  if (Number.isNaN(at)) return '';

  const seconds = (at - Date.now()) / 1000;

  if (unit !== undefined) return rel(Math.round(seconds / secondsIn(unit)), unit);

  // Choose the largest whole unit, then round the value for a short label.
  for (const [candidate, size] of UNITS) {
    if (Math.abs(seconds) >= size) return rel(Math.round(seconds / size), candidate);
  }
  return rel(Math.round(seconds), 'second');
}

/**
 * Seconds per unit, ordered from largest to smallest. Month and year lengths are averages.
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
  // `Intl` accepts singular and plural unit names.
  const singular = unit.endsWith('s') ? unit.slice(0, -1) : unit;
  return UNITS.find(([name]) => name === singular)?.[1] ?? 1;
}
