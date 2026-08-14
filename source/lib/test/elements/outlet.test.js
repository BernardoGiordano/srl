import { html } from 'lit';
import { signal } from '@core/foundation/reactive.js';
import { SignalElement } from '@core/elements/signal-element.js';
// Side-effect import: defines <x-outlet>. The class itself is only needed as a
// type here, and a value import used solely in JSDoc reads as unused to ESLint,
// which does not parse JSDoc comments. `@import` below is the type-only form.
import '@core/elements/outlet.js';
import { assert, mount, settled, unmountAll } from '../harness.js';

/** @import { ComponentOutlet } from '@core/elements/outlet.js' */
/** @import { OutletTarget } from '@core/elements/types.js' */

class PanelA extends SignalElement {
  render() {
    return html`<span class="who">A</span>`;
  }
}
customElements.define('panel-a', PanelA);

class PanelB extends SignalElement {
  static properties = { limit: { type: Number } };
  /** @type {number} */
  limit = 0;
  render() {
    return html`<span class="who">B:${this.limit}</span>`;
  }
}
customElements.define('panel-b', PanelB);

/**
 * Wait for one swap to land.
 *
 * The outlet is an adapter over `@core/elements/mount.js`, so a swap is a chain of
 * microtasks — definition, instantiation, the staleness check — rather than a
 * single turn. One macrotask drains the whole chain regardless of its length,
 * which is what keeps these tests off the outlet's internal await count.
 */
function swapped() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Resolves only when told to, so slow-load ordering can be tested deterministically. */
function deferred() {
  /** @type {() => void} */
  let release = () => undefined;
  const promise = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  return { promise, release: () => release() };
}

describe('ComponentOutlet', () => {
  /** @type {ComponentOutlet} */
  let outlet;

  beforeEach(() => {
    outlet = /** @type {ComponentOutlet} */ (mount('<x-outlet></x-outlet>'));
  });

  afterEach(() => {
    unmountAll();
  });

  it('mounts the target and swaps on signal change', async () => {
    const target = signal(/** @type {OutletTarget | null} */ ({ tag: 'panel-a' }));
    outlet.target = target;
    await swapped();
    await settled(/** @type {Element} */ (outlet.mounted));

    assert.equal(outlet.querySelector('.who')?.textContent, 'A');

    target.value = { tag: 'panel-b', props: { limit: 3 } };
    await swapped();
    await settled(/** @type {Element} */ (outlet.mounted));

    assert.equal(outlet.querySelector('.who')?.textContent, 'B:3');
  });

  it('assigns props as properties, not attributes', async () => {
    const target = signal(
      /** @type {OutletTarget | null} */ ({ tag: 'panel-b', props: { limit: 42 } }),
    );
    outlet.target = target;
    await swapped();

    const mounted = /** @type {PanelB} */ (outlet.mounted);
    assert.equal(typeof mounted.limit, 'number', 'an attribute would arrive as a string');
    assert.equal(mounted.limit, 42);
  });

  it('clears when the target becomes null', async () => {
    const target = signal(/** @type {OutletTarget | null} */ ({ tag: 'panel-a' }));
    outlet.target = target;
    await swapped();
    assert.ok(outlet.mounted);

    target.value = null;
    await swapped();

    assert.equal(outlet.mounted, null);
    assert.equal(outlet.childNodes.length, 0);
  });

  it('lets the newest swap win when a slow load resolves late', async () => {
    const slow = deferred();
    const target = signal(
      /** @type {OutletTarget | null} */ ({
        // Not yet defined, so the outlet must await `load`.
        tag: 'panel-slow',
        load: async () => {
          await slow.promise;
          customElements.define(
            'panel-slow',
            class extends SignalElement {
              render() {
                return html`<span class="who">SLOW</span>`;
              }
            },
          );
        },
      }),
    );
    outlet.target = target;
    await swapped();

    // Second navigation while the first is still loading.
    target.value = { tag: 'panel-a' };
    await swapped();

    // Now let the stale one finish. It must abandon itself.
    slow.release();
    await swapped();

    assert.equal(
      outlet.querySelector('.who')?.textContent,
      'A',
      'a late-resolving stale target must not overwrite the current one',
    );
  });

  it('keeps working after being moved, and keeps the element it already mounted', async () => {
    // What a projecting parent does to an outlet written inside its slot: capture
    // removes the node, the next render appends it into the content marker. The
    // property binding that set `target` does not run again, so the outlet has to
    // re-establish its own subscription.
    const target = signal(/** @type {OutletTarget | null} */ ({ tag: 'panel-a' }));
    outlet.target = target;
    await swapped();
    const first = outlet.mounted;

    const elsewhere = document.createElement('div');
    /** @type {Element} */ (outlet.parentElement).append(elsewhere);
    outlet.remove();
    elsewhere.append(outlet);
    await swapped();

    assert.equal(outlet.mounted, first, 'a move must not remount, which would reset the panel');

    target.value = { tag: 'panel-b', props: { limit: 7 } };
    await swapped();
    await settled(/** @type {Element} */ (outlet.mounted));

    assert.equal(outlet.querySelector('.who')?.textContent, 'B:7', 'the moved outlet must swap');
  });

  it('mounts the target it was given while detached once it is connected', async () => {
    // The order a capture produces when the outlet is created and bound in the same
    // render the parent projects: the swap is cancelled mid-flight by the removal,
    // and only the reconnection can finish it.
    const target = signal(/** @type {OutletTarget | null} */ ({ tag: 'panel-a' }));
    const parent = /** @type {Element} */ (outlet.parentElement);
    outlet.target = target;
    outlet.remove();
    await swapped();

    assert.equal(outlet.mounted, null, 'nothing may mount into a detached outlet');

    parent.append(outlet);
    await swapped();

    assert.equal(outlet.querySelector('.who')?.textContent, 'A');
  });

  it('reports a failed swap as an outlet-error event, not an unhandled rejection', async () => {
    const target = signal(/** @type {OutletTarget | null} */ ({ tag: 'never-defined-panel' }));

    /** @type {unknown} */
    let captured;
    outlet.addEventListener('outlet-error', (event) => {
      captured = /** @type {CustomEvent<{ error: unknown }>} */ (event).detail.error;
    });

    outlet.target = target;
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(captured instanceof Error, 'must surface the failure to the application');
    assert.includes(/** @type {Error} */ (captured).message, 'never-defined-panel');
  });

  it('bubbles outlet-error so a shell-level handler can catch every outlet', async () => {
    const target = signal(/** @type {OutletTarget | null} */ ({ tag: 'also-never-defined' }));

    let seenOnBody = false;
    const onBody = () => {
      seenOnBody = true;
    };
    document.body.addEventListener('outlet-error', onBody);
    try {
      outlet.target = target;
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      document.body.removeEventListener('outlet-error', onBody);
    }

    assert.ok(seenOnBody);
  });
});
