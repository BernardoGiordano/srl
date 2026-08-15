/**
 * The suites' standard-text resolver.
 *
 * A suite must not depend on a fetched message bundle, and the collection ships
 * no prose, so every suite that mounts a table, a filter, a combobox or a range
 * editor installs this dictionary through the same seam an application would use.
 * It is the third implementation of `TextResolver`, after the message table and
 * whatever an application injects, which is what makes the seam real rather than
 * hypothetical.
 *
 * The wording is deliberately terse and stable: assertions read `Previous`, not
 * `ui.table.previous`, and nothing here is translated because nothing here ships.
 */

import { configureCollectionText, STANDARD_TEXT } from '@components/internal/text.js';

/** Every key in `STANDARD_TEXT`, and nothing else. */
export const STANDARD_TEXT_FIXTURE = {
  'ui.table.empty': 'Empty',
  'ui.table.loading': 'Loading',
  'ui.table.pagination': 'Pages',
  'ui.table.previous': 'Previous',
  'ui.table.next': 'Next',
  'ui.table.pageSize': 'Rows',
  'ui.table.loadMore': 'More',
  'ui.table.sortAscending': 'Sort ascending by',
  'ui.table.sortDescending': 'Sort descending by',
  'ui.table.clearSort': 'Clear sort for',
  'ui.table.columns': 'Columns',
  'ui.table.resetColumns': 'Reset',
  'ui.table.moveBefore': 'Move before',
  'ui.table.moveAfter': 'Move after',
  'ui.table.stickyStart': 'Pin start',
  'ui.table.stickyEnd': 'Pin end',
  'ui.table.unstick': 'Unpin',
  'ui.table.resize': 'Resize',
  'ui.table.reorder': 'Reorder',
  'ui.filter.free': 'Text',
  'ui.filter.loading': 'Loading',
  'ui.filter.from': 'from',
  'ui.filter.to': 'to',
  'ui.combobox.notFound': 'No results',
  'ui.combobox.addTag': 'Search',
  'ui.combobox.clear': 'Clear all',
  'ui.combobox.remove': 'Remove',
  'ui.combobox.loading': 'Loading',
  'ui.dateRange.title': 'Pick a range',
  'ui.dateRange.since': 'From',
  'ui.dateRange.until': 'To',
  'ui.dateRange.confirm': 'Apply',
  'ui.dateRange.cancel': 'Cancel',
  'ui.dateRange.invalid': 'End is before start',
  'ui.field.required': 'Required',
  'ui.field.tooShort': 'Too short',
  'ui.field.tooLong': 'Too long',
  'ui.field.malformed': 'Not valid',
  'ui.field.notAllowed': 'Not allowed',
  'ui.field.tooSmall': 'Too small',
  'ui.field.tooLarge': 'Too large',
  'ui.field.future': 'In the future',
  'ui.field.past': 'In the past',
};

/**
 * Resolve standard text from the fixture for the rest of the suite.
 *
 * @param {Readonly<Record<string, string>>} [overrides] Keys this case wants
 *   answered differently, including with the empty string.
 */
export function useStandardText(overrides = {}) {
  /** @type {Record<string, string>} */
  const table = { ...STANDARD_TEXT_FIXTURE, ...overrides };
  configureCollectionText({ resolve: (key) => table[key] });
}

/** Hand standard text back to the message table. */
export function restoreStandardText() {
  configureCollectionText();
}

/** Every standard key the collection declares, as the resolver sees them. */
export function standardTextKeys() {
  return Object.entries(STANDARD_TEXT).flatMap(([namespace, { names }]) =>
    names.map((name) => `ui.${namespace}.${name}`),
  );
}
