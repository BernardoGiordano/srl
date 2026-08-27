import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { effect } from '@core/foundation/reactive.js';
import { currentPath } from '@core/navigation/router.js';
import { optionalAttr } from '../internal/dom.js';
import { panelBinding } from '../internal/open-panel.js';

/**
 * A dropdown: a trigger, and a panel that appears under it.
 *
 *     <ui-menu class="relative" trigger-class="…" panel-class="absolute end-0 …">
 *       <span slot="trigger"><ui-avatar …></ui-avatar></span>
 *       <div>…</div>
 *     </ui-menu>
 *
 * Positioning is the consumer's — `relative` on the host and `absolute` on the
 * panel covers the case every header needs, and a component that took a
 * `placement` prop would owe you a collision detector.
 *
 * What is here is the part that is always the same and always half-finished:
 * closing. A dropdown must close on a click outside it, on Escape with focus
 * returning to the trigger, and on a navigation. The first two belong to every
 * open panel and come from `open-panel.js`, which also writes the
 * `aria-expanded`/`aria-controls` pair. The third is this element's own, and it
 * is the one that gets forgotten: it leaves a user menu floating over the page
 * it just linked to.
 */
export class UiMenu extends SignalElement {
  static properties = {
    open: { type: Boolean, reflect: true, attribute: 'data-open' },
    triggerClass: { type: String, attribute: 'trigger-class' },
    panelClass: { type: String, attribute: 'panel-class' },
    panelRole: { type: String, attribute: 'panel-role' },
    label: { type: String },
  };

  open = false;
  triggerClass = '';
  panelClass = '';

  /**
   * Left empty on purpose. `role="menu"` is a promise about arrow-key
   * navigation and `menuitem` children; claiming it for a panel of links makes
   * a screen reader announce a menu that does not behave like one.
   */
  panelRole = '';

  /** Accessible name for the trigger. */
  label = '';

  /** @type {(() => void) | undefined} */
  #stopWatchingRoute;

  /**
   * Dismissal and the ARIA pair, but not position: `anchor: null` because a
   * header menu is placed by the two utility classes the consumer already wrote,
   * and a component that took a `placement` prop would owe you a collision
   * detector.
   */
  #panel = panelBinding({
    host: this,
    trigger: '[data-ui-part="menu-trigger"]',
    panel: '[data-ui-part="menu-panel"]',
    anchor: null,
    lifetime: () => this.lifetime,
    onDismiss: () => {
      this.open = false;
    },
  });

  get labelAttr() {
    return optionalAttr(this.label);
  }

  get roleAttr() {
    return optionalAttr(this.panelRole);
  }

  connectedCallback() {
    super.connectedCallback();

    let previous = currentPath.value;
    this.#stopWatchingRoute = effect(() => {
      const next = currentPath.value;
      if (next === previous) return;
      previous = next;
      this.open = false;
    });
  }

  onDestroy() {
    this.#stopWatchingRoute?.();
    this.#stopWatchingRoute = undefined;
  }

  /** @param {Map<PropertyKey, unknown>} changed */
  updated(changed) {
    super.updated(changed);
    this.#panel.sync(this.open);
  }

  toggle() {
    this.open = !this.open;
  }

  close() {
    this.open = false;
  }
}

await defineComponent({ tag: 'ui-menu', element: UiMenu, module: import.meta.url });
