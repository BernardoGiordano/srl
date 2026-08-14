import { nothing } from 'lit';
import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { currentPath } from '@core/navigation/router.js';

/**
 * One navigable row in a sidebar.
 *
 *     <ui-sidebar-item href="/settings/users" link-class="…" active-class="…">
 *       <svg …></svg>
 *       <span class="group-data-collapsed/sidebar:hidden">Users</span>
 *     </ui-sidebar-item>
 *
 * Everything inside the row is the consumer's: icon, label, badge, order. What
 * this owns is the part that is identical in every application and wrong in
 * most of them — deciding whether the row is the current one.
 *
 * `/` matches only itself. Every other path matches itself and its subtree, so
 * `/settings` stays lit on `/settings/users`, which is what a section link is
 * for. `exact` turns that off for a link that must not.
 *
 * The result is published as `data-active` on the host *and* as `active-class`
 * on the anchor, because the two get used for different things: the attribute
 * for styling descendants, the class list for the row itself.
 */
export class UiSidebarItem extends SignalElement {
  static properties = {
    href: { type: String },
    exact: { type: Boolean },
    linkClass: { type: String, attribute: 'link-class' },
    activeClass: { type: String, attribute: 'active-class' },
  };

  href = '';
  exact = false;
  linkClass = '';
  activeClass = '';

  /**
   * Reads the router's path signal, so the row re-renders on navigation with no
   * subscription written anywhere.
   *
   * @returns {boolean}
   */
  get isActive() {
    const path = currentPath.value;
    if (this.href === '') return false;
    if (this.exact || this.href === '/') return path === this.href;
    return path === this.href || path.startsWith(`${this.href}/`);
  }

  get linkClasses() {
    return this.isActive ? `${this.linkClass} ${this.activeClass}` : this.linkClass;
  }

  /** `aria-current` is absent, not `false`, when the row is not the current page. */
  get currentAttr() {
    return this.isActive ? 'page' : nothing;
  }

  /** @param {Map<PropertyKey, unknown>} changed */
  updated(changed) {
    super.updated(changed);
    // Not a reactive property: it is derived from a signal the render already
    // read, so setting it here cannot loop and needs no declaration.
    this.toggleAttribute('data-active', this.isActive);
  }
}

await defineComponent({ tag: 'ui-sidebar-item', element: UiSidebarItem, module: import.meta.url });
