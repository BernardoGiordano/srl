/**
 * Validators most forms need.
 *
 * A validator maps a value to an error code, or to the empty string when the value is
 * acceptable. Codes keep wording out of the framework and follow language changes.
 * `ui-field` turns a code into text, and the codes are the collection's standard text
 * keys under `ui.field.*`.
 *
 * Domain rules, such as the segments a customer may belong to, belong in the
 * application as plain functions of the same type.
 *
 * The container validators (`ordered`, `sameAs`, `minRows`, `maxRows`, `uniqueBy`)
 * take a group's value or an array's rows, and their code belongs to the container.
 * Asynchronous rules need an application's service, so applications write those and
 * pass them as `field(…, { async: […] })`.
 *
 * @import { Validator } from '@core/forms/types.js'
 */

/**
 * Requires a value that isn't only whitespace. An empty array counts as absent, so it
 * works for multi-selects too.
 *
 * @returns {Validator<unknown>}
 */
export function required() {
  return (value) => (isEmpty(value) ? 'required' : '');
}

/**
 * @param {number} length
 * @returns {Validator<string>}
 */
export function minLength(length) {
  return (value) => (isEmpty(value) || value.trim().length >= length ? '' : 'tooShort');
}

/**
 * Counts the raw value, because it guards a column width and the database counts
 * spaces too.
 *
 * @param {number} length
 * @returns {Validator<string>}
 */
export function maxLength(length) {
  return (value) => (value.length <= length ? '' : 'tooLong');
}

/**
 * An empty value passes, since emptiness is `required`'s job.
 *
 * @param {RegExp} expression
 * @param {string} [code]
 * @returns {Validator<string>}
 */
export function pattern(expression, code = 'malformed') {
  // Reset `lastIndex`, or a `/g` or `/y` regex alternates between pass and fail.
  return (value) => {
    if (isEmpty(value)) return '';
    expression.lastIndex = 0;
    return expression.test(value) ? '' : code;
  };
}

/**
 * The pattern is permissive on purpose. Only the mail server knows whether an address
 * works, and a stricter pattern rejects real ones.
 *
 * @returns {Validator<string>}
 */
export function email() {
  return pattern(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/u);
}

/**
 * @param {readonly string[]} allowed
 * @returns {Validator<string>}
 */
export function oneOf(allowed) {
  return (value) => (isEmpty(value) || allowed.includes(value) ? '' : 'notAllowed');
}

/**
 * A numeric lower bound over a string, because controls hold strings.
 *
 * @param {number} limit
 * @returns {Validator<string>}
 */
export function min(limit) {
  return (value) => {
    const numeric = toNumber(value);
    if (numeric === null) return value.trim() === '' ? '' : 'malformed';
    return numeric >= limit ? '' : 'tooSmall';
  };
}

/**
 * @param {number} limit
 * @returns {Validator<string>}
 */
export function max(limit) {
  return (value) => {
    const numeric = toNumber(value);
    if (numeric === null) return value.trim() === '' ? '' : 'malformed';
    return numeric <= limit ? '' : 'tooLarge';
  };
}

/**
 * A `YYYY-MM-DD` day no later than `latest`, which defaults to today, so `notAfter()`
 * reads as "not in the future". The default is computed per call, so a tab left open
 * overnight uses the new day.
 *
 * @param {string} [latest] `YYYY-MM-DD`.
 * @returns {Validator<string>}
 */
export function notAfter(latest) {
  return (value) => {
    if (isEmpty(value)) return '';
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || Number.isNaN(Date.parse(value))) return 'malformed';
    // ISO days sort as strings, and `Date.parse` would bring in a timezone.
    return value <= (latest ?? today()) ? '' : 'future';
  };
}

/**
 * A `YYYY-MM-DD` day, no earlier than `earliest`.
 *
 * @param {string} [earliest] `YYYY-MM-DD`. Defaults to today.
 * @returns {Validator<string>}
 */
export function notBefore(earliest) {
  return (value) => {
    if (isEmpty(value)) return '';
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || Number.isNaN(Date.parse(value))) return 'malformed';
    return value >= (earliest ?? today()) ? '' : 'past';
  };
}

/**
 * Two group members in order, as `YYYY-MM-DD` days or other strings that sort as they
 * read. Use it for date ranges.
 *
 * Equal values pass, since a one-day period is valid. An empty side passes too, since
 * emptiness is `required`'s job.
 *
 * @param {string} earlier Member name.
 * @param {string} later Member name.
 * @param {string} [code]
 * @returns {Validator<Readonly<Record<string, unknown>>>}
 */
export function ordered(earlier, later, code = 'outOfOrder') {
  return (value) => {
    const from = value[earlier];
    const to = value[later];
    if (typeof from !== 'string' || typeof to !== 'string') return '';
    if (isEmpty(from) || isEmpty(to)) return '';
    return from <= to ? '' : code;
  };
}

/**
 * Two group members holding the same value, such as a confirmed password. An empty
 * side passes, so the empty field reports `required` instead.
 *
 * @param {string} source Member name.
 * @param {string} copy Member name.
 * @param {string} [code]
 * @returns {Validator<Readonly<Record<string, unknown>>>}
 */
export function sameAs(source, copy, code = 'mismatched') {
  return (value) => {
    const left = value[source];
    const right = value[copy];
    if (isEmpty(left) || isEmpty(right)) return '';
    return Object.is(left, right) ? '' : code;
  };
}

/**
 * At least this many rows. `minRows(1)` is the common case.
 *
 * @param {number} count
 * @returns {Validator<readonly unknown[]>}
 */
export function minRows(count) {
  return (rows) => (rows.length >= count ? '' : 'tooFewRows');
}

/**
 * At most this many rows.
 *
 * @param {number} count
 * @returns {Validator<readonly unknown[]>}
 */
export function maxRows(count) {
  return (rows) => (rows.length <= count ? '' : 'tooManyRows');
}

/**
 * No two rows share this member's value. Empty values are ignored, so two new rows
 * aren't duplicates.
 *
 * The code belongs to the array and names no row. To mark the repeating row itself,
 * use `applyErrors({ 'contacts.1.email': 'duplicated' })`.
 *
 * @param {string} name Member name within a row.
 * @param {string} [code]
 * @returns {Validator<readonly Readonly<Record<string, unknown>>[]>}
 */
export function uniqueBy(name, code = 'duplicated') {
  return (rows) => {
    /** @type {Set<unknown>} */
    const seen = new Set();
    for (const row of rows) {
      const value = row[name];
      if (isEmpty(value)) continue;
      if (seen.has(value)) return code;
      seen.add(value);
    }
    return '';
  };
}

/** @returns {string} Today as `YYYY-MM-DD`, the format a `<input type="date">` holds. */
export function today() {
  const now = new Date();
  // The local date, because `toISOString()` returns yesterday's date shortly after
  // midnight in time zones east of UTC.
  return `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * Whether a control's value is absent, for every shape it can take.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isEmpty(value) {
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'string') return value.trim() === '';
  return value === null || value === undefined;
}

/**
 * @param {string} value
 * @returns {number | null} Null when the text is not a finite number.
 */
function toNumber(value) {
  if (value.trim() === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}
