import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { effect } from '@core/foundation/reactive.js';
import { currentPath } from '@core/navigation/router.js';

/**
 * The outermost region of an enterprise layout: a sidebar beside everything
 * else, plus the one piece of behaviour that region always needs and nobody
 * enjoys rewriting — an off-canvas drawer on small screens.
 *
 * It renders no wrapper of its own. The host is the flex (or grid) container,
 * the application puts the classes on it, and the two `<x-content>` markers are
 * `display: contents`, so the projected sidebar and the projected main column
 * are the direct flex items:
 *
 *     <ui-app-shell class="flex min-h-screen" backdrop-class="fixed inset-0 z-20 bg-black/40">
 *       <ui-sidebar slot="sidebar" class="...">…</ui-sidebar>
 *       <div class="flex min-w-0 flex-1 flex-col">…</div>
 *     </ui-app-shell>
 *
 * What it owns:
 *
 *  - `data-drawer-open` on the host, so the sidebar's off-canvas position is a
 *    CSS concern (`group-data-drawer-open:translate-x-0`) rather than a class
 *    list this component would have to know about.
 *  - Escape closes the drawer.
 *  - A navigation closes the drawer, because a menu that stays over the page
 *    the user just navigated to is the single most common bug in this layout.
 *  - A backdrop element, rendered only while the drawer is open, whose classes
 *    the application supplies.
 */
export class UiAppShell extends SignalElement {
  static properties = {
    // Reflected as `data-*` rather than as a bare `drawer-open` attribute so it
    // is addressable with Tailwind's `data-drawer-open:` variant, on this
    // element and on descendants through `group-data-drawer-open:`. A bare
    // attribute needs an arbitrary variant, which nobody writes twice.
    drawerOpen: { type: Boolean, reflect: true, attribute: 'data-drawer-open' },
    backdropClass: { type: String, attribute: 'backdrop-class' },
  };

  drawerOpen = false;

  /** Classes for the backdrop. Empty means an invisible, still-clickable one. */
  backdropClass = '';

  /** @type {(() => void) | undefined} */
  #stopWatchingRoute;

  connectedCallback() {
    super.connectedCallback();

    // Subscriptions are set up here and torn down in onDestroy, rather than in
    // onMount, because onMount fires once for the life of the instance while
    // onDestroy fires on every disconnect. Pairing them the other way leaves a
    // reattached element permanently unsubscribed.
    let previous = currentPath.value;
    this.#stopWatchingRoute = effect(() => {
      const next = currentPath.value;
      if (next === previous) return;
      previous = next;
      this.drawerOpen = false;
    });

    window.addEventListener('keydown', this.#onKeydown, { signal: this.lifetime });
  }

  onDestroy() {
    this.#stopWatchingRoute?.();
    this.#stopWatchingRoute = undefined;
  }

  /** @param {KeyboardEvent} event */
  #onKeydown = (event) => {
    if (event.key === 'Escape') this.closeDrawer();
  };

  toggleDrawer() {
    this.drawerOpen = !this.drawerOpen;
  }

  closeDrawer() {
    this.drawerOpen = false;
  }
}

await defineComponent({ tag: 'ui-app-shell', element: UiAppShell, module: import.meta.url });
