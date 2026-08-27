import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { loadPreference, savePreference } from '@core/preferences/persistence.js';
import { schedule } from '@core/foundation/clock.js';
import { signal } from '@core/foundation/reactive.js';

/** @typedef {{ collapsed: boolean }} SidebarState */

const SIDEBAR_STATE_VERSION = 1;

/** A collapse can be held down or animated; only where it lands has to be stored. */
const PERSIST_DEBOUNCE_MS = 250;

/**
 * A collapsible sidebar. Holds one piece of state — collapsed or not — and
 * renders nothing but its own children.
 *
 * The state is published three ways, on purpose, because three different kinds
 * of consumer need it:
 *
 *  - `data-collapsed` on the host, for CSS. This is how the width changes and
 *    how every label inside disappears, with no JavaScript involved:
 *
 *        <ui-sidebar class="group/sidebar w-60 data-collapsed:w-[76px]">
 *          <span class="group-data-collapsed/sidebar:hidden">Settings</span>
 *
 *  - `collapsedSignal`, for components that must re-render when it changes.
 *    `<ui-sidebar-toggle>` reads it to keep `aria-expanded` honest.
 *  - `collapsed`, an ordinary property, for imperative callers.
 *
 * Set `storage-key` and the choice survives a reload. That is one line here and
 * a bug report otherwise, because a sidebar that forgets is noticed on every
 * single navigation.
 *
 * The key names a `preferences/persistence.js` entry rather than a raw
 * `localStorage` slot, so an application that swaps the store swaps it here too.
 * ADR-0015. The stored value is the versioned envelope every other preference
 * uses, under `ui.component-state:ui-sidebar:<storage-key>`; a value written by an
 * earlier build is not read, so the first load after upgrading starts expanded
 * once.
 */
export class UiSidebar extends SignalElement {
  static properties = {
    collapsed: { type: Boolean, reflect: true, attribute: 'data-collapsed' },
    storageKey: { type: String, attribute: 'storage-key' },
  };

  /** Component-state id for the collapsed state. Empty means do not persist. */
  storageKey = '';

  #collapsed = signal(false);

  /**
   * The call that cancels a scheduled write, while one is scheduled. From the
   * injected clock, not `setTimeout`. ADR-0079.
   *
   * @type {(() => void) | undefined}
   */
  #cancelPersist;

  /**
   * The state as a signal, for anything that renders from it.
   *
   * A Lit reactive property notifies *this* element's scheduler and nothing
   * else, so a sibling component reading `sidebar.collapsed` would render once
   * with the initial value and then quietly go stale. Exposing the signal is
   * what makes cross-component reactivity work without either side importing
   * the other's state.
   *
   * @returns {import('@core/foundation/types.js').ReadonlySignal<boolean>}
   */
  get collapsedSignal() {
    return this.#collapsed;
  }

  /** @returns {boolean} */
  get collapsed() {
    return this.#collapsed.value;
  }

  set collapsed(value) {
    const previous = this.#collapsed.peek();
    if (previous === value) return;
    this.#collapsed.value = value;
    // Lit does not see through the accessor to the signal, so the reflection
    // and the re-render have to be asked for by hand.
    this.requestUpdate('collapsed', previous);
    this.#persist(value);
  }

  connectedCallback() {
    super.connectedCallback();
    const stored = this.#read();
    if (stored !== undefined) this.collapsed = stored;
  }

  onDestroy() {
    // Flush rather than cancel: navigating away right after collapsing must not
    // be the one case where the choice is forgotten.
    if (this.#cancelPersist === undefined) return;
    this.#cancelPersist();
    this.#cancelPersist = undefined;
    this.#write(this.collapsed);
  }

  toggle() {
    this.collapsed = !this.collapsed;
  }

  collapse() {
    this.collapsed = true;
  }

  expand() {
    this.collapsed = false;
  }

  /**
   * Storage can be unavailable (Safari private mode, a blocked third-party
   * context) or hold something written by another version. `loadPreference`
   * already treats every one of those as "no stored state", which is the right
   * answer here: a sidebar that throws on load because it wanted to remember its
   * width is a worse outcome than one that forgets.
   *
   * @returns {boolean | undefined}
   */
  #read() {
    if (this.storageKey === '') return undefined;
    const stored = /** @type {SidebarState | undefined} */ (
      loadPreference('ui-sidebar', this.storageKey, {
        schemaVersion: SIDEBAR_STATE_VERSION,
      })
    );
    return typeof stored?.collapsed === 'boolean' ? stored.collapsed : undefined;
  }

  /**
   * Debounced, because `collapsed` is a signal an animation or a keyboard repeat
   * can drive: the visible state is the signal's, and storage only has to agree
   * with wherever it settles.
   *
   * @param {boolean} value
   */
  #persist(value) {
    if (this.storageKey === '') return;
    this.#cancelPersist?.();
    this.#cancelPersist = schedule(() => {
      this.#cancelPersist = undefined;
      this.#write(value);
    }, PERSIST_DEBOUNCE_MS);
  }

  /** @param {boolean} value */
  #write(value) {
    savePreference(
      'ui-sidebar',
      this.storageKey,
      /** @type {SidebarState} */ ({ collapsed: value }),
      { schemaVersion: SIDEBAR_STATE_VERSION },
    );
  }
}

await defineComponent({ tag: 'ui-sidebar', element: UiSidebar, module: import.meta.url });
