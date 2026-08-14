import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { currentPath } from '@core/navigation/router.js';
import { nextElementId, optionalAttr } from '../internal/dom.js';

/**
 * A collapsible section of sidebar rows. The accordion every enterprise menu
 * has, with the two behaviours that make one usable:
 *
 *  - it opens itself when the current route is inside it, so a reload on a deep
 *    link does not present a closed menu with no indication of where you are;
 *  - a click still wins, so opening a section to look at it does not fight the
 *    router, and closing the section you are inside stays closed.
 *
 *     <ui-sidebar-group match="/settings" trigger-class="…" panel-class="…">
 *       <span slot="trigger" class="…">icon, label, chevron</span>
 *       <div class="…">
 *         <ui-sidebar-item …></ui-sidebar-item>
 *       </div>
 *     </ui-sidebar-group>
 *
 * NAMED CONTENT MUST BE A WHOLE ELEMENT
 *
 * `slot="trigger"` has to sit on an element that exists when this component
 * captures its content, so a `*if` or `*for` cannot produce the trigger itself —
 * wrap it, as above. The default slot has no such rule: projection moves the
 * caller's binding anchors along with its output, so a structural directive can
 * stand on its own there. See projection.js.
 */
export class UiSidebarGroup extends SignalElement {
  static properties = {
    open: { type: Boolean },
    match: { type: String },
    triggerClass: { type: String, attribute: 'trigger-class' },
    panelClass: { type: String, attribute: 'panel-class' },
    label: { type: String },
  };

  /** Authored or imperative state. `expanded` is what actually renders. */
  open = false;

  /** Path prefix that auto-opens this group. Empty means never. */
  match = '';

  triggerClass = '';
  panelClass = '';
  label = '';

  /** Has a human decided? Until then the route decides. */
  #chosen = false;

  #panelId = nextElementId('ui-sidebar-group');

  get panelId() {
    return this.#panelId;
  }

  /**
   * Reads the router's signal, which is what re-runs this on navigation.
   *
   * @returns {boolean}
   */
  get matchesPath() {
    const path = currentPath.value;
    if (this.match === '') return false;
    return path === this.match || path.startsWith(`${this.match}/`);
  }

  get expanded() {
    return this.#chosen ? this.open : this.open || this.matchesPath;
  }

  get expandedAttr() {
    return String(this.expanded);
  }

  get labelAttr() {
    return optionalAttr(this.label);
  }

  toggle() {
    this.open = !this.expanded;
    this.#chosen = true;
    // `open` may not have changed value — closing a group that was open only
    // because the route matched sets false to false — and Lit schedules on
    // change. Ask explicitly rather than relying on the two agreeing.
    this.requestUpdate();
  }

  /** @param {Map<PropertyKey, unknown>} changed */
  updated(changed) {
    super.updated(changed);
    this.toggleAttribute('data-open', this.expanded);
  }
}

await defineComponent({ tag: 'ui-sidebar-group', element: UiSidebarGroup, module: import.meta.url });
