import { defineComponent } from '@core/elements/component.js';
import { MountSequence, createElement } from '@core/elements/mount.js';
import { effect } from '@core/foundation/reactive.js';

/** @import { MountRequest, OutletTarget } from '@core/elements/types.js' */
/** @import { ReadonlySignal } from '@core/foundation/types.js' */

/**
 * `<x-outlet>` swaps its child component when a signal changes, like Angular's
 * `NgComponentOutlet` driven by a signal.
 *
 *     const view = signal({ load: () => import('./chart-panel.js').then((m) => m.ChartPanel) });
 *     outlet.target = view;
 *     view.value = { tag: TablePanel, props: { rows } };
 *
 * Prefer naming the component by class, so a renamed tag can't leave a stale string.
 * Loading, races and replacement follow `@core/elements/mount.js`. The outlet reads
 * the signal inside an effect and reports a failed swap as an `outlet-error` event.
 *
 * It extends `HTMLElement` because it manages its children directly.
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
   * Resume tracking after a move.
   *
   * A move is a removal and an insertion, so disconnecting tore down the effect. A
   * projecting parent moves an outlet into its `<x-content>` marker this way, and
   * the `target` binding doesn't run again.
   */
  connectedCallback() {
    if (this.#source !== undefined && this.#disposeTracking === undefined) this.#track();
  }

  disconnectedCallback() {
    this.#disposeTracking?.();
    this.#disposeTracking = undefined;
    // Nothing may mount into a detached outlet.
    this.#sequence.cancel();
  }

  /** Subscribe to the current source, replacing any earlier subscription. */
  #track() {
    const source = this.#source;
    if (source === undefined) return;

    this.#disposeTracking?.();
    this.#disposeTracking = effect(() => {
      // Read `source.value` before #swap's first await, or the effect won't track it.
      const next = source.value;

      // `Promise.catch` types its parameter as `any`, and `unknown` keeps that out of
      // the event detail.
      this.#swap(next).catch(/** @param {unknown} cause */ (cause) => {
        // A bubbling, composed event lets one shell handler cover every outlet.
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
    // Re-tracking after a move sees the same target. Keep the mounted element and
    // its state.
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
 * A template that uses `<x-outlet>` lists `ComponentOutlet` in `uses`, which also
 * imports this module. `template: false`, because the element manages its own
 * children.
 */
await defineComponent({
  tag: 'x-outlet',
  element: ComponentOutlet,
  module: import.meta.url,
  template: false,
});
