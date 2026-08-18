/**
 * Mount and release cycles, for the workloads whose answer is a heap reading.
 *
 * These are shaped differently from the other browser modules: each export does a
 * whole batch of cycles and then removes everything it created, because the
 * measurement is taken from Node *between* batches — collect garbage, read the
 * heap, read the retained node and listener counts, run the next batch. A page
 * cannot do any of those three for itself, so the loop cannot live here.
 *
 * The contract each export keeps: when it returns, nothing it built is still in the
 * document, no router is attached, and no listener it added is still registered. A
 * function that cannot honour that has found a leak, which is the point.
 */

import { html } from 'lit';
import { defineComponent } from '@core/elements/component.js';
// Importing the module is what defines `<x-outlet>`; the class is not named here.
import '@core/elements/outlet.js';
import { signal } from '@core/foundation/reactive.js';
import { attachRouter } from '@core/navigation/router.js';
import { SignalElement } from '@core/elements/signal-element.js';

import { makeRows, rendered, settle, waitFor } from './support.js';

/** @import { OutletTarget } from '@core/elements/types.js' */

class CycleView extends SignalElement {
  render() {
    return html`<span class="cycle">view</span>`;
  }
}

class SlowView extends SignalElement {
  render() {
    return html`<span class="cycle">slow</span>`;
  }
}

let defined = false;

/**
 * @returns {Promise<void>}
 */
async function defineViews() {
  if (defined) return;
  defined = true;
  await defineComponent({
    tag: 'cycle-view',
    element: CycleView,
    module: import.meta.url,
    template: false,
  });
  await defineComponent({
    tag: 'slow-view',
    element: SlowView,
    module: import.meta.url,
    template: false,
  });
}

/**
 * `count` route mount/unmount cycles, then a released router.
 *
 * Each cycle navigates to a sibling and back, which mounts and releases a view
 * chain. The router's document listeners go with `stop()`, so a growing listener
 * count across batches means a release path missed one.
 *
 * @param {number} count
 * @returns {Promise<{ navigations: number, leftBehind: number }>}
 */
export async function routeCycles(count) {
  await defineViews();

  const container = document.createElement('div');
  const host = document.createElement('div');
  host.append(document.createElement('main'));
  container.append(host);
  document.body.append(container);

  const entry = `${location.pathname}${location.search}`;
  history.replaceState(null, '', '/cycle/one');

  const attachment = await attachRouter(host, [
    { path: '/cycle/one', component: CycleView },
    { path: '/cycle/two', component: SlowView },
    { path: '*', component: CycleView },
  ]);

  let navigations = 0;
  for (let turn = 0; turn < count; turn += 1) {
    await attachment.navigate('/cycle/two');
    await attachment.navigate('/cycle/one');
    navigations += 2;
  }

  attachment.stop();
  history.replaceState(null, '', entry);
  container.remove();
  await settle();

  return { navigations, leftBehind: document.querySelectorAll('.cycle').length };
}

/**
 * `count` outlet swaps in which the first target always loses the race.
 *
 * A swap is started and immediately superseded, so every cycle produces one
 * abandoned load. Those are the ones that leak if a mount sequence keeps a
 * reference to the element it decided not to use, and the check is that the outlet
 * holds exactly one child and it is the winner.
 *
 * @param {number} count
 * @returns {Promise<{ swaps: number, mounted: string, children: number }>}
 */
export async function outletSwaps(count) {
  await defineViews();

  const container = document.createElement('div');
  const outlet = document.createElement('x-outlet');
  container.append(outlet);
  document.body.append(container);

  /** @type {import('@core/foundation/reactive.js').Signal<OutletTarget | null>} */
  const target = signal(null);
  /** @type {{ target: import('@core/foundation/reactive.js').Signal<OutletTarget | null> }} */ (
    /** @type {unknown} */ (outlet)
  ).target = target;

  let swaps = 0;
  for (let turn = 0; turn < count; turn += 1) {
    // The loser: a load that resolves a task later, by which time the winner has
    // already been requested.
    target.value = {
      load: () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(SlowView), 0);
        }),
    };
    target.value = { tag: CycleView };
    swaps += 1;
    await waitFor(() => outlet.firstElementChild?.localName === 'cycle-view', 'the winning swap');
    // Give the loser time to resolve into a mount that must then be discarded.
    await settle();
  }

  const mounted = outlet.firstElementChild?.localName ?? 'nothing';
  const children = outlet.children.length;

  container.remove();
  await settle();

  return { swaps, mounted, children };
}

/** The table the mount/release pair below hands between two heap readings. */
/** @type {HTMLElement | null} */
let mountedTable = null;

/**
 * Mount a full table and leave it mounted.
 *
 * Split from its release because the interesting numbers are on either side of the
 * gap: the first measurements saw 170 MB while 10,000 rows were mounted and 4 MB
 * once they were gone (ADR-0037), and only Node can read a heap. So this returns
 * with the table on screen and `releaseTable()` takes it away.
 *
 * @param {number} rows
 * @returns {Promise<{ peakCells: number, renderedRows: number }>}
 */
export async function mountTable(rows) {
  await import('@components/data/ui-table.js');

  const container = document.createElement('div');
  container.dataset.benchTable = 'true';
  document.body.append(container);

  const table = document.createElement('ui-table');
  table.setAttribute('pagination', 'none');
  table.setAttribute('empty-label', 'Empty');
  for (const [key, label] of [
    ['name', 'Name'],
    ['email', 'Email'],
    ['meta.team', 'Team'],
    ['meta.city', 'City'],
  ]) {
    const column = document.createElement('ui-table-column');
    column.setAttribute('key', /** @type {string} */ (key));
    column.setAttribute('label', /** @type {string} */ (label));
    table.append(column);
  }
  container.append(table);

  const first = makeRows(rows);
  /** @type {{ rows: readonly unknown[] }} */ (/** @type {unknown} */ (table)).rows = first;
  await rendered(table);
  const peakCells = table.querySelectorAll('td').length;

  // Updated in place before the heap is read, because a table that has only ever
  // rendered once has not yet built whatever a second render caches.
  /** @type {{ rows: readonly unknown[] }} */ (/** @type {unknown} */ (table)).rows = first.map(
    (row) => ({ ...row, name: `${row.name} updated` }),
  );
  await rendered(table);

  mountedTable = container;
  return { peakCells, renderedRows: table.querySelectorAll('[data-ui-part="table-row"]').length };
}

/**
 * Remove the mounted table and report that nothing of it is left in the document.
 *
 * What remains in the *heap* is Node's question, asked after a forced collection.
 * A non-zero answer here would make that question meaningless, so it is checked.
 *
 * @returns {Promise<{ remainingRows: number, remainingContainers: number }>}
 */
export async function releaseTable() {
  mountedTable?.remove();
  mountedTable = null;
  await settle();
  return {
    remainingRows: document.querySelectorAll('[data-ui-part="table-row"]').length,
    remainingContainers: document.querySelectorAll('[data-bench-table]').length,
  };
}
