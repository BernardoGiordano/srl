/**
 * The standard interaction text of the shared collection.
 *
 * One key per standard string, named by the collection and resolved here: an
 * element asks for `empty`, this module asks the resolver for `ui.table.empty`.
 * The application still owns the language — the key names a message in *its*
 * bundle, and nothing here ships prose in any language — but it owns it once per
 * application instead of once per element per screen. A property per string meant
 * two screens carrying forty label bindings, and a twenty-first affordance could
 * not be added without editing every caller.
 *
 * Per-instance properties survive only where the wording names the data rather
 * than the interaction: `ui-table.emptyLabel`, `ui-combobox.notFoundLabel` and
 * `ui-combobox.addTagLabel`. "No employees yet" belongs to a screen; "Sort
 * ascending by" belongs to a table.
 *
 * The resolver is a signal holding a function, and resolution happens inside the
 * caller's render, so a locale change re-renders every mounted element that
 * resolved a key with no subscription in the collection. Replacing the resolver
 * invalidates the same way, because assigning one writes the signal.
 *
 * `undefined` from the resolver is a missing message and the key renders in its
 * place. The empty string is *not* missing — it is a deliberate "no words here",
 * which is what lets a range chip read `3/3 – 3/7` instead of `from 3/3 to 3/7`.
 */

import { messageTable } from '@core/localization/i18n.js';
import { signal } from '@core/foundation/reactive.js';

/**
 * Answers a standard-text key. `undefined` means the resolver has no message for
 * it; the empty string means it has one and it is deliberately empty.
 *
 * @typedef {(key: string) => string | undefined} TextResolver
 */

/**
 * Every standard string the collection asks for, and the element that asks.
 *
 * The inventory is here rather than written down somewhere, so it cannot drift
 * from the call sites: a name absent from this table resolves to the key itself
 * rather than to a message, and never reaches the application's bundle.
 *
 * Nothing outside these four elements has standard text. `ui-table-column`
 * labels, filter rule captions, group names and option labels are data, and data
 * arrives from the caller.
 */
export const STANDARD_TEXT = {
  table: {
    element: 'ui-table',
    names: [
      'empty',
      'loading',
      'pagination',
      'previous',
      'next',
      'pageSize',
      'loadMore',
      'sortAscending',
      'sortDescending',
      'clearSort',
      'columns',
      'resetColumns',
      'moveBefore',
      'moveAfter',
      'stickyStart',
      'stickyEnd',
      'unstick',
      'resize',
      'reorder',
    ],
  },
  filter: {
    element: 'ui-dynamic-filter',
    names: ['free', 'loading', 'from', 'to'],
  },
  combobox: {
    element: 'ui-combobox',
    names: ['notFound', 'addTag', 'clear', 'remove', 'loading'],
  },
  dateRange: {
    element: 'ui-date-range',
    names: ['title', 'since', 'until', 'confirm', 'cancel', 'invalid'],
  },
  /**
   * Error codes, not interaction labels, and the one namespace whose inventory is
   * a *vocabulary*: every code `@core/forms/validators.js` can return, and nothing
   * else. A code an application's server invents belongs to that application, and
   * reaches the field through `ui-field.messages` rather than through here — see
   * the note on that property for why the collection does not own it.
   */
  field: {
    element: 'ui-field',
    names: ['required', 'tooShort', 'tooLong', 'malformed', 'notAllowed', 'tooSmall', 'tooLarge', 'future', 'past'],
  },
};

/**
 * The message table, which is the resolver an application using this framework's
 * i18n needs and does not have to configure. Reading `messageTable` here is what
 * makes standard text follow a locale change.
 *
 * @type {TextResolver}
 */
const fromMessages = (key) => messageTable.value[key];

/**
 * A signal rather than a plain variable, so that replacing the resolver
 * re-resolves what is already on screen. A resolver of an application's own is
 * the second implementation of this seam; the suites' stub is a third.
 *
 * @type {import('@core/foundation/types.js').Signal<TextResolver>}
 */
const resolver = signal(fromMessages);

/**
 * Resolve standard text through something other than the message table.
 *
 * For an application whose copy lives elsewhere — a design-system service, a
 * server-rendered dictionary, a suite that must not depend on a fetched bundle.
 * Calling with no argument restores the message table.
 *
 * A resolver that reads a signal of its own stays reactive for free. One that
 * does not is re-read whenever this is called again, which is the invalidation
 * hook for a dictionary that changed underneath it.
 *
 * @param {{ resolve?: TextResolver }} [config]
 */
export function configureCollectionText(config = {}) {
  resolver.value = config.resolve ?? fromMessages;
}

/**
 * One standard string, for the element that owns the namespace.
 *
 * @param {keyof typeof STANDARD_TEXT} namespace
 * @param {string} name
 * @returns {string}
 */
export function standardText(namespace, name) {
  const key = `ui.${namespace}.${name}`;
  if (!STANDARD_TEXT[namespace].names.includes(name)) return key;
  return resolver.value(key) ?? key;
}
