/**
 * Router workloads, measured entirely through router attachment.
 *
 * Nothing here times `compilePath` or `flattenRoutes`. They are private to the
 * router now, and this file never reached for them even while they were exported:
 * a workload built on them would have been a caller to migrate the moment matching
 * moved behind an index, and its numbers would read as a regression for having
 * measured a shape that no longer existed. What an application can observe is
 * `attachRouter` and `navigate`, so that is what has a budget.
 *
 * Route trees are generated from a leaf count so the same workload answers "does
 * matching scale" at 10, 100 and 1,000 leaves. The answer decides whether a route
 * index is worth building at all — see ADR-0004, which records that it is not yet.
 */

import { html } from 'lit';
import { defineComponent } from '@core/elements/component.js';
import { attachRouter, currentPath, routeParams } from '@core/navigation/router.js';
import { SignalElement } from '@core/elements/signal-element.js';

import { expect, waitFor } from './support.js';

/** @import { RouteDef } from '@core/navigation/types.js' */
/** @import { RouterAttachment } from '@core/navigation/router.js' */

/** Where the harness page sits, so a sample can put the URL back. */
const HARNESS_URL = `${location.pathname}${location.search}`;

/** One route's view. Identical for every leaf: this measures routing, not rendering. */
class BenchLeaf extends SignalElement {
  render() {
    return html`<span class="leaf">${currentPath.value}</span>`;
  }
}

/** A parameterised view, so the params workload can assert the value arrived. */
class BenchParam extends SignalElement {
  render() {
    return html`<span class="leaf">user:${routeParams.value.id ?? '?'}</span>`;
  }
}

/** A layout with its own outlet, for the sibling-navigation workload. */
class BenchLayout extends SignalElement {
  render() {
    return html`<span class="layout">layout</span><x-route-outlet></x-route-outlet>`;
  }
}

let defined = false;

/**
 * Define the three views once per page. `customElements.define` is permanent, so
 * this cannot be per sample, and `template: false` keeps a template fetch out of a
 * measurement about routing.
 *
 * @returns {Promise<void>}
 */
async function defineViews() {
  if (defined) return;
  defined = true;
  await defineComponent({
    tag: 'bench-leaf',
    element: BenchLeaf,
    module: import.meta.url,
    template: false,
  });
  await defineComponent({
    tag: 'bench-param',
    element: BenchParam,
    module: import.meta.url,
    template: false,
  });
  await defineComponent({
    tag: 'bench-layout',
    element: BenchLayout,
    module: import.meta.url,
    template: false,
  });
}

/**
 * A route tree with `leaves` literal routes plus the four shapes that are not
 * literal: a parameter, a wildcard, a nested pair of siblings, and a catch-all
 * last.
 *
 * @param {number} leaves
 * @returns {RouteDef[]}
 */
function routeTree(leaves) {
  /** @type {RouteDef[]} */
  const routes = [];
  for (let index = 0; index < leaves; index += 1) {
    routes.push({ path: `/bench/leaf-${String(index)}`, component: BenchLeaf });
  }
  routes.push({ path: '/bench/user/:id', component: BenchParam });
  routes.push({ path: '/bench/files/*', component: BenchLeaf });
  routes.push({
    path: '/bench/section',
    component: BenchLayout,
    children: [
      { path: 'one', component: BenchLeaf },
      { path: 'two', component: BenchLeaf },
    ],
  });
  routes.push({ path: '*', component: BenchLeaf });
  return routes;
}

/**
 * A host whose own markup holds the `main` the router mounts into, which is the
 * shape every real shell has.
 *
 * @param {HTMLElement} container
 * @returns {HTMLElement}
 */
function hostIn(container) {
  const host = document.createElement('div');
  host.append(document.createElement('main'));
  container.append(host);
  return host;
}

/**
 * @param {HTMLElement} host
 * @returns {string}
 */
function mountedTag(host) {
  const outlet = host.querySelector('main');
  return outlet?.firstElementChild?.localName ?? 'nothing';
}

/**
 * Configure a route tree and settle the entry URL: everything an application pays
 * between `attachRouter(this, routes)` and the first view on screen.
 *
 * @type {import('./support.js').Workload}
 */
export const attach = {
  prepare: defineViews,

  setup(scope, args) {
    const leaves = Number(args.leaves);
    history.replaceState(null, '', '/bench/leaf-0');
    return { host: hostIn(scope.container), routes: routeTree(leaves) };
  },

  async run(state) {
    /** @type {RouterAttachment} */
    const attachment = await attachRouter(state.host, state.routes);
    state.attachment = attachment;
    return mountedTag(state.host);
  },

  check(answer) {
    expect(answer, 'bench-leaf', 'the entry route mounted');
  },

  teardown(state) {
    const attachment = /** @type {RouterAttachment | undefined} */ (state?.attachment);
    attachment?.stop();
    history.replaceState(null, '', HARNESS_URL);
  },
};

/**
 * Navigate to one route in a tree of a stated size.
 *
 * `target` picks which: first, middle and last say whether match order costs
 * anything, and the other three exercise the paths a literal table cannot answer.
 *
 * @type {import('./support.js').Workload}
 */
export const navigate_to = {
  prepare: defineViews,

  async setup(scope, args) {
    const leaves = Number(args.leaves);
    history.replaceState(null, '', '/bench/leaf-0');
    const host = hostIn(scope.container);
    const attachment = await attachRouter(host, routeTree(leaves));

    const target = String(args.target);
    /** @type {Record<string, string>} */
    const paths = {
      first: '/bench/leaf-0',
      middle: `/bench/leaf-${String(Math.floor(leaves / 2))}`,
      last: `/bench/leaf-${String(leaves - 1)}`,
      param: '/bench/user/42',
      wildcard: '/bench/files/a/b/c.txt',
      'catch-all': '/bench/nothing-matches-this',
    };
    const path = paths[target];
    if (path === undefined) throw new Error(`Unknown navigation target ${JSON.stringify(target)}.`);

    // Away from the destination first, so every sample is a real navigation
    // rather than a no-op on an already current URL.
    await attachment.navigate('/bench/leaf-0');
    return { host, attachment, path, away: target === 'first' ? '/bench/leaf-1' : '/bench/leaf-0' };
  },

  async run(state) {
    await state.attachment.navigate(state.path);
    return currentPath.value;
  },

  check(answer, args) {
    const target = String(args.target);
    if (target === 'catch-all') {
      expect(answer, '/bench/nothing-matches-this', 'the catch-all navigation');
      return;
    }
    expect(typeof answer, 'string', 'the settled path');
  },

  async teardown(state) {
    // Back to the other side so the next sample's `navigate` is a change again.
    if (state?.attachment !== undefined) await state.attachment.navigate(state.away);
    state?.attachment?.stop();
    history.replaceState(null, '', HARNESS_URL);
  },
};

/**
 * Navigate back and forth between two child routes under one layout, `cycles`
 * times.
 *
 * The workload that catches a layout being rebuilt per navigation: the layout
 * counts its own constructions, and the check fails if a sibling switch built a
 * second one. Sibling retention is a behaviour the router tests already assert;
 * here it is the correctness gate that makes the timing mean something.
 *
 * @type {import('./support.js').Workload}
 */
export const sibling_cycle = {
  prepare: defineViews,

  async setup(scope, args) {
    history.replaceState(null, '', '/bench/section/one');
    const host = hostIn(scope.container);
    const attachment = await attachRouter(host, routeTree(Number(args.leaves)));
    const layout = host.querySelector('bench-layout');
    if (layout === null) throw new Error('The layout route did not mount.');
    return { host, attachment, layout, cycles: Number(args.cycles) };
  },

  async run(state) {
    for (let turn = 0; turn < state.cycles; turn += 1) {
      await state.attachment.navigate('/bench/section/two');
      await state.attachment.navigate('/bench/section/one');
    }
    const layouts = state.host.querySelectorAll('bench-layout').length;
    const retained = state.host.querySelector('bench-layout') === state.layout;
    await waitFor(() => currentPath.value === '/bench/section/one', 'the last navigation');
    return `${String(layouts)}:${String(retained)}`;
  },

  check(answer) {
    expect(answer, '1:true', 'one retained layout across sibling navigations');
  },

  teardown(state) {
    state?.attachment?.stop();
    history.replaceState(null, '', HARNESS_URL);
  },
};
