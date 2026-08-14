import { defineComponent } from '@core/elements/component.js';
import { MountSequence, createElement } from '@core/elements/mount.js';
import { effect } from '@core/foundation/reactive.js';

/** @import { MountRequest, OutletTarget } from '@core/elements/types.js' */
/** @import { ReadonlySignal } from '@core/foundation/types.js' */

/**
 * `<x-outlet>` swaps its child component whenever a signal changes. Angular's
 * `NgComponentOutlet`, driven by a signal instead of a template binding.
 *
 *     const view = signal({ load: () => import('./chart-panel.js').then((m) => m.ChartPanel) });
 *     outlet.target = view;
 *     view.value = { tag: TablePanel, props: { rows } };
 *
 * A target names its component as a class, a definition or a tag. The class is
 * the one worth preferring: it is the same value the component's definition
 * registered, so a renamed tag cannot leave a stale string here.
 *
 * An adapter over `@core/elements/mount.js`: an `OutletTarget` is a `MountRequest` with a
 * signal in front of it, and the loading, definition, race and replacement rules
 * are that module's. What is the outlet's own is the reactive part — reading the
 * signal inside an effect, and reporting a failed swap as a DOM event, because a
 * lazily loaded panel whose chunk 404s is a routine production event and the
 * application needs somewhere to hang an error state.
 *
 * A plain `HTMLElement`, not a `SignalElement`. It owns its children imperatively
 * and would only fight lit-html for control of the same DOM.
 */
export class ComponentOutlet extends HTMLElement {
  /** @type {(() => void) | undefined} */
  #disposeTracking;

  #sequence = new MountSequence();

  /** @type {HTMLElement | null} */
  #mounted = null;

  /** @type {ReadonlySignal<OutletTarget | null> | undefined} */
  #source;

  /** The target `#mounted` was built from, so a re-run can tell a move from a swap. */
  /** @type {OutletTarget | null | undefined} */
  #placed;

  /**
   * @param {ReadonlySignal<OutletTarget | null>} source
   */
  set target(source) {
    this.#source = source;
    this.#track();
  }

  /** The element currently mounted, or null. */
  get mounted() {
    return this.#mounted;
  }

  /**
   * An outlet that was moved rather than removed has to start tracking again.
   *
   * Moving a node is a removal followed by an insertion, so a projecting parent
   * relocating this element into its `<x-content>` marker — the ordinary case for
   * an outlet written inside a card's slot — tears the effect down on the way out.
   * The property binding that set `target` does not run a second time, so without
   * this the outlet would sit in the document holding a signal it no longer reads.
   */
  connectedCallback() {
    if (this.#source !== undefined && this.#disposeTracking === undefined) this.#track();
  }

  disconnectedCallback() {
    this.#disposeTracking?.();
    this.#disposeTracking = undefined;
    // Nothing further may mount into an outlet the document no longer holds.
    this.#sequence.cancel();
  }

  /** Subscribe to the current source, replacing any earlier subscription. */
  #track() {
    const source = this.#source;
    if (source === undefined) return;

    this.#disposeTracking?.();
    this.#disposeTracking = effect(() => {
      // `source.value` is read synchronously, in the effect body, before #swap
      // suspends on its first await. That ordering is what registers the
      // dependency. Writing `effect(async () => { ... await ...; source.value })`
      // would read it after the first suspension, outside the tracking context,
      // and the outlet would never update again.
      const next = source.value;

      // `Promise.catch` types its callback parameter as `any`. Annotating it
      // `unknown` keeps that `any` from leaking into the event detail.
      this.#swap(next).catch(/** @param {unknown} cause */ (cause) => {
        // A failed swap must not become an unhandled rejection. Bubbling and
        // composed, so one handler on the shell can catch every outlet's
        // failures.
        this.dispatchEvent(
          new CustomEvent('outlet-error', {
            bubbles: true,
            composed: true,
            detail: { error: cause, target: next },
          }),
        );
        console.error('<x-outlet> failed to mount', cause);
      });
    });
  }

  /**
   * @param {OutletTarget | null} target
   * @returns {Promise<void>}
   */
  async #swap(target) {
    // Re-tracking after a move re-reads the same target. The element it produced
    // is still here, so remounting would throw away a panel's state to arrive at
    // the DOM already on screen.
    if (target === this.#placed && this.#mounted?.parentNode === this) return;

    const attempt = this.#sequence.begin();

    if (target === null) {
      this.replaceChildren();
      this.#mounted = null;
      this.#placed = null;
      return;
    }

    /** @type {MountRequest} */
    const request = {
      where: '<x-outlet>',
      tag: target.tag,
      load: target.load,
      props: target.props,
    };

    const element = await createElement(request);
    if (!(await attempt.place(this, element, request))) return;
    this.#mounted = element;
    this.#placed = target;
  }
}

/**
 * A definition like any component's, so a template that says `<x-outlet>` has to
 * list `ComponentOutlet` in its `uses` — which is also the import that makes this
 * module evaluate. The outlet used to be reached by a bare `import '@core/elements/outlet.js'`
 * beside a template that mentioned the tag, and nothing connected the two.
 *
 * `template: false`: this element owns its children imperatively and would only
 * fight lit-html for control of the same DOM.
 */
await defineComponent({
  tag: 'x-outlet',
  element: ComponentOutlet,
  module: import.meta.url,
  template: false,
});
