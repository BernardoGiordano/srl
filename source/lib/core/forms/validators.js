/**
 * The validators every form repeats, and nothing beyond them.
 *
 * A validator is a plain function from a value to an error *code*, or the empty
 * string when the value is acceptable. Codes rather than sentences, for the same
 * reason the rest of this library refuses to hold prose: a message frozen at
 * module evaluation cannot follow a language change, and a validator that
 * imported `t()` would decide an application's wording from inside the framework.
 * `ui-field` resolves the code; see `source/components/inputs/ui-field.js`.
 *
 * What is here is what more than one screen would otherwise rewrite. What is
 * deliberately not here is every rule an application has — a customer's segment
 * must be one of four, an order cannot ship before it is confirmed — because
 * those are domain rules, and a domain rule written as a framework validator is
 * a framework that has opinions about the domain. Write them as functions in the
 * screen or the service; they compose with these because the type is the whole
 * contract.
 *
 * The codes are the collection's standard text keys under `ui.field.*`, so an
 * application that adds none of its own still gets sentences.
 *
 * CONTAINER RULES
 *
 * The last four take a group's value or an array's rows rather than one field's
 * value, and they are the same type: a validator over whatever the node holds.
 * Their code belongs to the container, which is what `ui-form-error` displays.
 *
 * What is deliberately not here is anything asynchronous. Every such rule needs a
 * service, an endpoint and a payload this library knows nothing about, so an
 * application writes the function and hands it to `field(…, { async: […] })`.
 *
 * @import { Validator } from '@core/forms/types.js'
 */

/**
 * Present, and not only whitespace. The one validator nearly every field has.
 *
 * An empty array counts as absent, which is what makes it work unchanged on a
 * multi-select: "choose at least one" and "type something" are the same question
 * asked of two shapes.
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
 * Counted on the raw value rather than the trimmed one, because it guards a
 * column width and the database counts the spaces too.
 *
 * @param {number} length
 * @returns {Validator<string>}
 */
export function maxLength(length) {
  return (value) => (value.length <= length ? '' : 'tooLong');
}

/**
 * An empty value passes: emptiness is `required`'s question, and a field that
 * answered both would report "malformed" for a field nobody has filled in.
 *
 * @param {RegExp} expression
 * @param {string} [code]
 * @returns {Validator<string>}
 */
export function pattern(expression, code = 'malformed') {
  // A stateful regex — /g or /y — advances `lastIndex` between calls, so the same
  // value would pass and fail alternately. Tested per call rather than documented.
  return (value) => {
    if (isEmpty(value)) return '';
    expression.lastIndex = 0;
    return expression.test(value) ? '' : code;
  };
}

/**
 * Deliberately permissive. The address is either deliverable or it is not, and
 * the only component that knows which is the server that sends the mail; a
 * stricter expression here rejects real addresses to no purpose.
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
 * Numeric bounds over a *string*, because that is what a control holds — see the
 * note on `field()` about why the conversion does not happen earlier.
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
 * A `YYYY-MM-DD` day, no later than `latest` — which defaults to today, so the
 * common case is `notAfter()` and reads as "not in the future".
 *
 * The default is evaluated per call rather than captured, or a tab left open
 * overnight validates against yesterday.
 *
 * @param {string} [latest] `YYYY-MM-DD`.
 * @returns {Validator<string>}
 */
export function notAfter(latest) {
  return (value) => {
    if (isEmpty(value)) return '';
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || Number.isNaN(Date.parse(value))) return 'malformed';
    // String comparison, which is why the format matters: ISO days sort
    // lexicographically, and `Date.parse` would drag a timezone into a question
    // that has none.
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
 * Two of a group's members in order, as `YYYY-MM-DD` days or as any two strings
 * that sort the way they read. The rule a date range is written with.
 *
 * Equal passes: a period that starts and ends on the same day is one day long,
 * not an error. Either side empty passes too, because emptiness is `required`'s
 * question and a half-filled range is not yet out of order.
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
 * Two of a group's members holding the same value. A confirmed password, a
 * re-typed address.
 *
 * Either side empty passes, so the field that must be filled in says `required`
 * rather than the group saying they differ.
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
 * At least this many rows. `minRows(1)` is the one nearly every field array has.
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
 * No two rows share this member's value.
 *
 * Empty values are ignored: two rows the user has just added are not duplicates
 * of each other, and the field that must be filled in says so itself.
 *
 * The answer belongs to the array, so it names no row. A message under *the* row
 * that repeats is `applyErrors({ 'contacts.1.email': 'duplicated' })` — the same
 * address a 422 carries, and it clears when that control is edited.
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
  // Local, not `toISOString()`: at 01:00 in Milan the UTC date is still yesterday,
  // and a "not in the future" rule that rejects today is the bug that follows.
  return `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * Absent, for every shape a control's value takes.
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
