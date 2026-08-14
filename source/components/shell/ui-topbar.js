import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';

/**
 * The page header strip. Projects its children unchanged and adds the two
 * things a header needs that markup cannot express:
 *
 *  - `role="banner"`, unless the consumer set a role, so the region is
 *    announced and reachable by landmark navigation.
 *  - `data-stuck` once the page has scrolled past `stuck-offset`, which is how
 *    a header grows a shadow when content passes underneath it without any
 *    application writing a scroll handler:
 *
 *        <ui-topbar class="sticky top-0 data-stuck:shadow-md">
 *
 * The scroll listener is passive and attached to the element's lifetime, so it
 * unregisters itself when the header leaves the DOM.
 */
export class UiTopbar extends SignalElement {
  static properties = {
    stuckOffset: { type: Number, attribute: 'stuck-offset' },
  };

  /** Scroll position, in pixels, past which `data-stuck` appears. */
  stuckOffset = 0;

  connectedCallback() {
    super.connectedCallback();
    if (!this.hasAttribute('role')) this.setAttribute('role', 'banner');
    window.addEventListener('scroll', this.#onScroll, { passive: true, signal: this.lifetime });
    this.#onScroll();
  }

  #onScroll = () => {
    this.toggleAttribute('data-stuck', window.scrollY > this.stuckOffset);
  };
}

await defineComponent({ tag: 'ui-topbar', element: UiTopbar, module: import.meta.url });
