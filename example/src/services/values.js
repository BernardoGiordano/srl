/**
 * Reading values out of a JSON payload.
 *
 * Two functions, and they exist because `String(value)` on an `unknown` is a bug waiting
 * for a schema change: an object reaching it renders `[object Object]` on screen, which is
 * the kind of thing that ships. `typescript-eslint`'s `no-base-to-string` rule says so, and
 * the fix is not a suppression — it is deciding, once, what a non-scalar means here.
 *
 * The decision: a string, a number or a boolean is text; anything else is absent. A filter
 * value that arrived as an object is not a filter value, and dropping it is what makes the
 * query the user sees match the query that goes out.
 */

/**
 * @param {unknown} value
 * @returns {string} The empty string for anything that is not a scalar.
 */
export function text(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return String(value);
  return '';
}

/**
 * A filter descriptor's value as a list of query values.
 *
 * One value, a list for a `multiple` rule, or nothing. Empty entries are dropped rather
 * than sent: `?status=` filters on the empty string in most APIs, which is a match nothing
 * has, so a screen would show no rows and no reason.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function textList(value) {
  if (Array.isArray(value)) {
    return /** @type {unknown[]} */ (value).map(text).filter((entry) => entry !== '');
  }
  const single = text(value);
  return single === '' ? [] : [single];
}
