/**
 * What "filtered" means, in the one place both sides of a filter can read it.
 *
 * `ui-dynamic-filter` produces filter descriptors and `ui-table` applies them, and
 * the two deliberately do not import each other: a screen wires them together with
 * one assignment, and either can be replaced without touching the other.
 *
 * The vocabulary is here — `ANY_COLUMN`, the three match modes, and the row
 * comparison itself — because a contract private to the table is a contract a rule
 * cannot express. With it inside the table, `'*'` was a string screens had to
 * know, `equals` could not be asked for so choosing *Sales* also selected
 * *Pre-Sales*, and a `daterange` rule matched nothing unless the screen wrote a
 * predicate by hand.
 *
 * It imports nothing and touches no DOM, so a third filter surface gets the same
 * meaning of "matches" for free, and testing it needs no render pass.
 */

/**
 * The key that means "every declared column" rather than one of them.
 *
 * A screen writes `{ ref: ANY_COLUMN, type: 'free' }` instead of knowing that the
 * table spells it `'*'`.
 */
export const ANY_COLUMN = '*';

/**
 * How a range value joins its two bounds. The upper bound is exclusive, so the
 * comparison is `since <= value < until`; `ui-date-range` re-exports this as
 * `DATE_RANGE_SEPARATOR` and owns the inclusive-day conversion its fields show.
 */
export const RANGE_SEPARATOR = ' to ';

/** What a filter with no `match` of its own does. */
const DEFAULT_MATCH = 'contains';

/**
 * @typedef {'contains' | 'equals' | 'range'} FilterMatch
 * @typedef {(row: unknown, value: unknown, index: number) => boolean} FilterPredicate
 * @typedef {{
 *   key?: string,
 *   value: unknown,
 *   match?: FilterMatch,
 *   predicate?: FilterPredicate,
 * }} FilterDescriptor
 * @typedef {{
 *   key: string,
 *   filterValue?: (row: unknown, index: number, value: unknown) => unknown,
 * }} FilterColumn
 */

/**
 * The match each rule type means when the rule does not say.
 *
 * This is the table that was missing. A listed choice is an identity: the option
 * carries the value the field holds, so `equals` is what picking it means, and
 * substring matching there is a bug that looks like a feature until two of your
 * values share a prefix. Free text is the opposite — a person typing `mil` wants
 * `Milano` — and a range is neither.
 *
 * @type {Readonly<Record<string, FilterMatch>>}
 */
const MATCH_BY_RULE_TYPE = Object.freeze({
  boolean: 'equals',
  option: 'equals',
  date: 'equals',
  children: 'equals',
  observer: 'equals',
  lazy: 'equals',
  typeahead: 'equals',
  free: 'contains',
  daterange: 'range',
});

/**
 * @param {string} type
 * @returns {FilterMatch}
 */
export function matchForRuleType(type) {
  return MATCH_BY_RULE_TYPE[type] ?? DEFAULT_MATCH;
}

/**
 * Read a dotted path out of a row. An empty path is the row itself.
 *
 * @param {unknown} source
 * @param {string} path
 * @returns {unknown}
 */
export function readPath(source, path) {
  if (path === '') return source;
  let value = source;
  for (const part of path.split('.')) {
    if (value === null || value === undefined || typeof value !== 'object') return undefined;
    value = /** @type {Record<string, unknown>} */ (value)[part];
  }
  return value;
}

/**
 * A value as comparable text: lower-cased, `Date` as its ISO form, anything with
 * no sensible text form as empty rather than `[object Object]`.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().toLocaleLowerCase();
  if (
    typeof value !== 'string' &&
    typeof value !== 'number' &&
    typeof value !== 'bigint' &&
    typeof value !== 'boolean'
  ) {
    return '';
  }
  return String(value).toLocaleLowerCase();
}

/**
 * Does this row satisfy this descriptor?
 *
 * An empty value matches everything: a filter the user has not filled in is not a
 * filter that excludes every row. A `predicate` wins over `match`, because a rule
 * that brought its own comparison meant it.
 *
 * @param {unknown} row
 * @param {number} index
 * @param {FilterDescriptor} descriptor
 * @param {readonly FilterColumn[]} columns
 * @returns {boolean}
 */
export function matchesRow(row, index, descriptor, columns) {
  if (descriptor === null || typeof descriptor !== 'object') return true;
  if (descriptor.value === null || descriptor.value === undefined || descriptor.value === '') {
    return true;
  }
  if (typeof descriptor.predicate === 'function') {
    return descriptor.predicate(row, descriptor.value, index);
  }

  const match = descriptor.match ?? DEFAULT_MATCH;
  const key = descriptor.key ?? ANY_COLUMN;

  if (key === ANY_COLUMN) {
    return columns.some((column) =>
      compareValue(columnValue(row, index, column, column.key), descriptor.value, match),
    );
  }

  const column = columns.find((candidate) => candidate.key === key);
  return compareValue(columnValue(row, index, column, key), descriptor.value, match);
}

/**
 * The value a column filters on: its own `filterValue` if it declares one — a
 * formatted cell is what the user sees and therefore what they expect to search —
 * and otherwise the raw field.
 *
 * @param {unknown} row
 * @param {number} index
 * @param {FilterColumn | undefined} column
 * @param {string} path
 * @returns {unknown}
 */
function columnValue(row, index, column, path) {
  const value = readPath(row, column?.key ?? path);
  return column?.filterValue?.(row, index, value) ?? value;
}

/**
 * @param {unknown} candidate
 * @param {unknown} expected
 * @param {FilterMatch} match
 * @returns {boolean}
 */
export function compareValue(candidate, expected, match) {
  if (Array.isArray(candidate)) {
    return candidate.some((value) => compareValue(value, expected, match));
  }
  if (match === 'range') return withinRange(candidate, expected);
  if (match === 'equals') {
    if (typeof candidate === 'string' && typeof expected === 'string') {
      return normalizeText(candidate) === normalizeText(expected);
    }
    return Object.is(candidate, expected);
  }
  return normalizeText(candidate).includes(normalizeText(expected));
}

/**
 * `since <= value < until`, on `YYYY-MM-DD` days, which compare as text in
 * exactly the order they compare as dates. A `Date` is reduced to its UTC day
 * first, because the bounds are days and comparing a day to a timestamp would
 * exclude the whole of the last day in the range.
 *
 * @param {unknown} candidate
 * @param {unknown} expected
 * @returns {boolean}
 */
function withinRange(candidate, expected) {
  if (typeof expected !== 'string') return true;
  const [since, until] = expected.split(RANGE_SEPARATOR);
  if (since === undefined || until === undefined) return true;
  const day = asDay(candidate);
  if (day === '') return false;
  return day >= since && day < until;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function asDay(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value !== 'string') return '';
  return value.slice(0, 10);
}
