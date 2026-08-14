import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { currentPath } from '@core/navigation/router.js';

/**
 * The tab strip of a detail screen: one link per child route.
 *
 * The tabs are links, not buttons, and that is the whole design. A child route has a
 * URL; a URL can be opened in a new tab, bookmarked, shared in a ticket and reached
 * with the back button, and a tab strip built from click handlers has none of those
 * properties. The router does the rest — the layout above stays mounted, so switching
 * tabs replaces the panel and nothing else.
 *
 * Which tab is current is read from `currentPath`, so this element subscribes to
 * navigation by rendering and needs no input about the route it is inside.
 *
 * @typedef {object} TabItem
 * @property {string} key
 * @property {string} label
 * @property {string} href
 * @property {boolean} [exact] Match this href exactly. The index tab needs it, because
 *   its href is a prefix of every sibling's.
 */
export class AppTabs extends SignalElement {
  static properties = {
    // A property rather than an attribute: an array does not survive being
    // stringified into one, and `[.items]` exists for exactly this.
    items: { attribute: false },
    label: { type: String },
  };

  /** @type {readonly TabItem[]} */
  items = [];

  /** Accessible name of the tab list. */
  label = '';

  /**
   * @param {TabItem} item
   * @returns {boolean}
   */
  isCurrent(item) {
    const path = currentPath.value.replace(/\/$/u, '');
    const href = item.href.replace(/\/$/u, '');
    return item.exact === true ? path === href : path === href || path.startsWith(`${href}/`);
  }

  /**
   * @param {TabItem} item
   * @returns {string}
   */
  linkClasses(item) {
    return this.isCurrent(item)
      ? 'border-accent text-brand'
      : 'border-transparent text-muted hover:border-ui-border hover:text-ink';
  }

  /**
   * `aria-current="page"` rather than `aria-selected`: these are links in a
   * navigation, not tabs in a tabpanel widget, and claiming the widget role without
   * its keyboard behaviour is worse than not claiming it.
   *
   * `'false'` rather than removing the attribute, because an attribute binding that
   * resolves to `undefined` leaves the attribute present and empty, and
   * `aria-current=""` is not the same statement as "not current".
   *
   * @param {TabItem} item
   * @returns {'page' | 'false'}
   */
  currentAttr(item) {
    return this.isCurrent(item) ? 'page' : 'false';
  }
}

await defineComponent({ tag: 'app-tabs', element: AppTabs, module: import.meta.url });
