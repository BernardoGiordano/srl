import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { effect } from '@core/foundation/reactive.js';
import { currentPath } from '@core/navigation/router.js';
import { nextElementId, optionalAttr } from '../internal/dom.js';

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
 * returning to the trigger, and on a navigation. The third is the one that gets
 * forgotten, and it leaves a user menu floating over the page it just linked
 * to.
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

  #panelId = nextElementId('ui-menu');

  /** @type {(() => void) | undefined} */
  #stopWatchingRoute;

  get panelId() {
    return this.#panelId;
  }

  get expandedAttr() {
    return String(this.open);
  }

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

    // pointerdown rather than click: a click listener fires after the mouse is
    // released, so a drag that starts inside the panel and ends outside it
    // closes the menu mid-gesture.
    document.addEventListener('pointerdown', this.#onPointerDown, { signal: this.lifetime });
    document.addEventListener('keydown', this.#onKeydown, { signal: this.lifetime });
  }

  onDestroy() {
    this.#stopWatchingRoute?.();
    this.#stopWatchingRoute = undefined;
  }

  /** @param {PointerEvent} event */
  #onPointerDown = (event) => {
    if (!this.open) return;
    const target = event.target;
    if (target instanceof Node && this.contains(target)) return;
    this.open = false;
  };

  /** @param {KeyboardEvent} event */
  #onKeydown = (event) => {
    if (event.key !== 'Escape' || !this.open) return;
    this.open = false;
    // Focus goes back where it came from. Leaving it on a removed element sends
    // the next Tab to the top of the document.
    this.querySelector('button')?.focus();
  };

  toggle() {
    this.open = !this.open;
  }

  close() {
    this.open = false;
  }
}

await defineComponent({ tag: 'ui-menu', element: UiMenu, module: import.meta.url });
