import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { UiAppShell } from '@components/shell/ui-app-shell.js';
import { UiSidebar } from '@components/shell/ui-sidebar.js';
import { optionalAttr } from '../internal/dom.js';

/**
 * The button that collapses the sidebar, or opens the mobile drawer.
 *
 *     <ui-sidebar-toggle button-class="..." label="Collapse the menu">
 *       <svg class="group-data-collapsed/sidebar:rotate-180">…</svg>
 *     </ui-sidebar-toggle>
 *
 * It finds what it controls with `closest()` rather than being handed a
 * reference or reading a shared singleton. That is the whole reason two
 * sidebars on one page work, and it is the same lookup Angular's element
 * injector does for a directive that wants its host component.
 *
 * `for="drawer"` targets the enclosing `<ui-app-shell>` instead, which is what
 * a hamburger in the header wants: the same component, a different ancestor.
 *
 * WHY IT RENDERS ITS OWN <button>
 *
 * Because the alternative is `role="button"` plus keydown handling on the host,
 * which is a worse button. The convention across this collection is therefore:
 * the component owns the semantic element and the consumer styles it through a
 * `*-class` property, while the host stays free for layout.
 */
export class UiSidebarToggle extends SignalElement {
  static properties = {
    for: { type: String },
    buttonClass: { type: String, attribute: 'button-class' },
    label: { type: String },
  };

  /** `collapse` targets the nearest ui-sidebar, `drawer` the nearest ui-app-shell. */
  /** @type {'collapse' | 'drawer'} */
  for = 'collapse';

  buttonClass = '';

  /** Accessible name. Pass `t('…')`; this collection ships no strings of its own. */
  label = '';

  /** An empty label removes `aria-label` rather than emptying it — see `dom.js`. */
  get labelAttr() {
    return optionalAttr(this.label);
  }

  /**
   * `aria-expanded` describes the thing being controlled, so it has to track
   * that thing's state. Reading the signal here — during render — is what
   * subscribes this component to a state it does not own.
   *
   * Resolved on every render rather than cached, because at first render this
   * element may still be sitting in its parent's projection bucket, detached,
   * with no ancestors at all. Reconnection requests another update, and by then
   * `closest()` finds it.
   *
   * @returns {string}
   */
  get expanded() {
    if (this.for === 'drawer') {
      const shell = this.closest('ui-app-shell');
      return shell instanceof UiAppShell ? String(shell.drawerOpen) : 'false';
    }
    const sidebar = this.closest('ui-sidebar');
    return sidebar instanceof UiSidebar ? String(!sidebar.collapsedSignal.value) : 'true';
  }

  toggle() {
    if (this.for === 'drawer') {
      const shell = this.closest('ui-app-shell');
      if (shell instanceof UiAppShell) shell.toggleDrawer();
      return;
    }
    const sidebar = this.closest('ui-sidebar');
    if (sidebar instanceof UiSidebar) sidebar.toggle();
  }
}

await defineComponent({ tag: 'ui-sidebar-toggle', element: UiSidebarToggle, module: import.meta.url });
