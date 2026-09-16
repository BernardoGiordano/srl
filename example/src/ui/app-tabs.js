import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { currentPath } from '@core/navigation/router.js';

/**
 * Render child routes as links. `currentPath` marks the active link, so the strip
 * follows navigation without its own route state.
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
    // The template assigns this array as a property.
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
   * Mark the current page on these navigation links. Return `'false'` for the
   * other links because an empty `aria-current` would remain in the DOM.
   *
   * @param {TabItem} item
   * @returns {'page' | 'false'}
   */
  currentAttr(item) {
    return this.isCurrent(item) ? 'page' : 'false';
  }
}

await defineComponent({ tag: 'app-tabs', element: AppTabs, module: import.meta.url, styles: true });
