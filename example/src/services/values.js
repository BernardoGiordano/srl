/**
 * Read scalar values from JSON. Objects and arrays are absent rather than rendered
 * as `[object Object]`.
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
 * Return nonempty query values from a single value or a list.
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
