/**
 * Every workload, in one table.
 *
 * A workload is a record, not a function, so that adding one is a table entry and
 * reading the suite is reading a list. The browser ones name a module the page
 * imports and one export in it; the Node ones carry their own `run`. Nothing else
 * distinguishes them, which is what lets the runner treat "compile a template" and
 * "time the typecheck" the same way.
 *
 * WHAT IS NOT HERE YET
 *
 * The plan lists workloads this first harness does not implement, and they are named
 * in `PENDING` below rather than left to be noticed later. A gate that silently
 * covers less than its plan says is worse than one that reports the gap, because the
 * gap is what the next agent needs.
 */

import { MEMORY_WORKLOADS } from './node/lifecycle.mjs';
import { STARTUP_WORKLOADS } from './node/startup.mjs';
import { TOOLING_WORKLOADS } from './node/tooling.mjs';

/** @import { Mode, WorkloadSpec } from './types.js' */

/**
 * Sample counts by cost. A workload whose single run is milliseconds can afford
 * dozens of samples; one that renders 40,000 cells cannot, and pretending otherwise
 * is how a benchmark gate becomes something people skip.
 *
 * These are higher than they first were, and the reason is worth keeping: at twelve
 * samples, two runs of unchanged code disagreed by up to 70% on a 4 ms table filter.
 * A median needs enough samples to be a median. Forty samples of a 4 ms workload cost
 * 160 ms, which buys a number that can carry a 20% budget.
 *
 * @type {Record<string, { samples: Record<Mode, number>, warmup: Record<Mode, number> }>}
 */
const COST = {
  cheap: { samples: { local: 60, ci: 40 }, warmup: { local: 8, ci: 5 } },
  medium: { samples: { local: 30, ci: 20 }, warmup: { local: 5, ci: 3 } },
  heavy: { samples: { local: 12, ci: 8 }, warmup: { local: 3, ci: 2 } },
  brutal: { samples: { local: 5, ci: 4 }, warmup: { local: 1, ci: 1 } },
};

/**
 * @param {{
 *   id: string,
 *   suite: import('./types.js').Suite,
 *   title: string,
 *   module: string,
 *   export: string,
 *   cost: keyof typeof COST,
 *   args?: Record<string, unknown>,
 *   driver?: 'browser' | 'page',
 *   units?: Record<string, string>,
 *   localOnly?: boolean,
 * }} spec
 * @returns {WorkloadSpec}
 */
function browserWorkload(spec) {
  const cost = /** @type {{ samples: Record<Mode, number>, warmup: Record<Mode, number> }} */ (
    COST[spec.cost]
  );
  return {
    id: spec.id,
    suite: spec.suite,
    title: spec.title,
    driver: spec.driver ?? 'browser',
    samples: cost.samples,
    warmup: cost.warmup,
    units: spec.units,
    localOnly: spec.localOnly,
    browser: { module: `/__benchmark/${spec.module}`, export: spec.export, args: spec.args ?? {} },
  };
}

/** @type {WorkloadSpec[]} */
const DEFINITION_WORKLOADS = [100, 1000, 5000].map((count) =>
  browserWorkload({
    id: `startup/definitions-${String(count)}`,
    suite: 'startup',
    title: `Register ${count.toLocaleString('en')} components, then build 100 instances`,
    module: 'definitions.js',
    export: 'define_scale',
    // A fresh page per sample: `customElements.define` is permanent, so a second
    // sample in the same page would measure a registry the first one filled.
    driver: 'page',
    cost: count >= 5000 ? 'brutal' : 'heavy',
    args: { count },
    units: { duration: 'ms', define: 'ms', instantiate: 'ms' },
  }),
);

/** @type {WorkloadSpec[]} */
const TEMPLATE_WORKLOADS = [
  ...[
    { size: 'small', bindings: 10 },
    { size: 'medium', bindings: 50 },
    { size: 'large', bindings: 200 },
  ].flatMap(({ size, bindings }) => [
    browserWorkload({
      id: `template/compile-${size}`,
      suite: 'template',
      title: `Compile a ${size} template (${String(bindings)} bindings)`,
      module: 'template.js',
      export: 'compile',
      cost: 'cheap',
      args: { bindings },
    }),
    browserWorkload({
      id: `template/first-render-${size}`,
      suite: 'template',
      title: `Render a ${size} template for the first time`,
      module: 'template.js',
      export: 'first_render',
      cost: 'cheap',
      args: { bindings },
    }),
  ]),

  ...[50, 200].map((bindings) =>
    browserWorkload({
      id: `template/update-one-of-${String(bindings)}`,
      suite: 'template',
      title: `Update one binding among ${String(bindings)} unrelated ones`,
      module: 'template.js',
      export: 'update_one_binding',
      cost: 'cheap',
      args: { bindings },
    }),
  ),

  ...['create', 'update', 'reverse', 'shrink', 'regrow'].map((mutation) =>
    browserWorkload({
      id: `template/keyed-${mutation}-1000`,
      suite: 'template',
      title: `Keyed *for list: ${mutation} at 1,000 rows`,
      module: 'template.js',
      export: 'keyed_list',
      cost: 'medium',
      args: { count: 1000, mutation },
    }),
  ),

  browserWorkload({
    id: 'template/keyed-reverse-10000',
    suite: 'template',
    title: 'Keyed *for list: reverse 10,000 rows',
    module: 'template.js',
    export: 'keyed_list',
    cost: 'brutal',
    args: { count: 10_000, mutation: 'reverse' },
  }),
];

/** @type {WorkloadSpec[]} */
const ROUTER_WORKLOADS = [
  ...[10, 100, 1000].map((leaves) =>
    browserWorkload({
      id: `router/attach-${String(leaves)}`,
      suite: 'router',
      title: `Configure ${leaves.toLocaleString('en')} routes and settle the entry URL`,
      module: 'router.js',
      export: 'attach',
      cost: leaves >= 1000 ? 'heavy' : 'medium',
      args: { leaves },
    }),
  ),

  ...['first', 'middle', 'last', 'param', 'wildcard', 'catch-all'].map((target) =>
    browserWorkload({
      id: `router/navigate-${target}-100`,
      suite: 'router',
      title: `Navigate to the ${target} route of 100`,
      module: 'router.js',
      export: 'navigate_to',
      cost: 'medium',
      args: { leaves: 100, target },
    }),
  ),

  browserWorkload({
    id: 'router/navigate-last-1000',
    suite: 'router',
    title: 'Navigate to the last route of 1,000',
    module: 'router.js',
    export: 'navigate_to',
    cost: 'medium',
    args: { leaves: 1000, target: 'last' },
  }),

  browserWorkload({
    id: 'router/sibling-cycle-10',
    suite: 'router',
    title: 'Ten navigations between sibling child routes under one layout',
    module: 'router.js',
    export: 'sibling_cycle',
    cost: 'medium',
    args: { leaves: 100, cycles: 10 },
  }),
];

/** @type {WorkloadSpec[]} */
const COLLECTION_WORKLOADS = [
  browserWorkload({
    id: 'collection/table-mount-10000-50',
    suite: 'collection',
    title: 'Mount a client table of 10,000 rows with 50 visible',
    module: 'collection.js',
    export: 'table_mount',
    cost: 'medium',
    args: { rows: 10_000, pageSize: 50 },
  }),

  ...[100, 1000, 10_000].flatMap((rows) => [
    browserWorkload({
      id: `collection/table-filter-${String(rows)}`,
      suite: 'collection',
      title: `Filter ${rows.toLocaleString('en')} client rows`,
      module: 'collection.js',
      export: 'table_filter',
      cost: rows >= 10_000 ? 'medium' : 'cheap',
      args: { rows },
    }),
    browserWorkload({
      id: `collection/table-sort-${String(rows)}`,
      suite: 'collection',
      title: `Sort ${rows.toLocaleString('en')} client rows`,
      module: 'collection.js',
      export: 'table_sort',
      cost: rows >= 10_000 ? 'medium' : 'cheap',
      args: { rows },
    }),
  ]),

  browserWorkload({
    id: 'collection/table-full-render-10000',
    suite: 'collection',
    title: 'Render 10,000 rows and 40,000 cells at once',
    module: 'collection.js',
    export: 'table_full_render',
    cost: 'brutal',
    args: { rows: 10_000 },
    units: { duration: 'ms', render: 'ms', cells: 'count' },
  }),

  browserWorkload({
    id: 'collection/table-reorder-10000',
    suite: 'collection',
    title: 'Keyed reverse of a fully rendered 10,000-row table',
    module: 'collection.js',
    export: 'table_reorder',
    cost: 'brutal',
    args: { rows: 10_000 },
  }),

  browserWorkload({
    id: 'collection/table-sticky-realistic',
    suite: 'collection',
    // `sticky` is a count per edge, so this is four sticky columns, as the
    // worst case below is twelve. The old title said two and measured four.
    title: 'Eight columns, four sticky, 1,000 rows',
    module: 'collection.js',
    export: 'table_sticky',
    cost: 'medium',
    args: { columns: 8, sticky: 2, rows: 1000 },
  }),

  browserWorkload({
    id: 'collection/table-sticky-worst-case',
    suite: 'collection',
    title: 'Twenty-four columns, twelve sticky, 1,000 rows',
    module: 'collection.js',
    export: 'table_sticky',
    cost: 'medium',
    args: { columns: 24, sticky: 6, rows: 1000 },
  }),

  ...[100, 1000].map((options) =>
    browserWorkload({
      id: `collection/combobox-filter-${String(options)}`,
      suite: 'collection',
      title: `Type into a combobox holding ${options.toLocaleString('en')} local options`,
      module: 'collection.js',
      export: 'combobox_filter',
      cost: 'medium',
      args: { options },
    }),
  ),
];

/** @type {WorkloadSpec[]} */
export const WORKLOADS = [
  ...STARTUP_WORKLOADS,
  ...DEFINITION_WORKLOADS,
  ...TEMPLATE_WORKLOADS,
  ...ROUTER_WORKLOADS,
  ...COLLECTION_WORKLOADS,
  ...MEMORY_WORKLOADS,
  ...TOOLING_WORKLOADS,
];

/**
 * Workloads this harness should run and does not yet, with the reason.
 *
 * Printed by every run and written into every result file, so "the gate passed"
 * cannot be mistaken for "the gate covered everything". Each entry is a task for a
 * later commit, not a decision to leave it out.
 *
 * @type {ReadonlyArray<{ id: string, reason: string }>}
 */
export const PENDING = [
  {
    id: 'startup/templates-bundle',
    reason:
      'No application configures `manifest.templateBundle` and no templates.json is committed, ' +
      'so there is nothing to compare individual template fetches against. Generating one would ' +
      'write into an application directory, which a measurement must not do.',
  },
  {
    id: 'memory/remote-cycles',
    reason:
      'Fifty remote mount/revoke/unmount cycles need a manifest, a remote host provider and an ' +
      'auth session in the harness page. Worth doing against the real example page rather than a ' +
      'synthetic one, which is a page-driven workload this harness can host but does not yet.',
  },
  {
    id: 'collection/typeahead',
    reason:
      'The typeahead path is defined by not loading options locally, so its workload is a ' +
      'request-timing measurement against a stubbed source rather than a render measurement. ' +
      'Needs a decision on what the stub is before a number means anything.',
  },
  {
    id: 'delivery/edit-to-reload',
    reason:
      'One-file edit to browser reload needs cli/dev/serve.mjs running with its watcher and a page ' +
      'listening on /__reload. That is a second origin shape, and mixing it into the measured ' +
      'origin would change the cache policy every other workload depends on.',
  },
];

/**
 * The workloads a mode runs.
 *
 * @param {Mode} mode
 * @param {{ suites?: readonly string[], only?: readonly string[], app?: string, origin?: 'source' | 'dist' }} filter
 * @returns {WorkloadSpec[]}
 */
export function selectWorkloads(mode, filter) {
  return WORKLOADS.filter((workload) => {
    if (mode === 'ci' && workload.localOnly === true) return false;
    if (workload.apps !== undefined) {
      if (filter.app === undefined || !workload.apps.includes(filter.app)) return false;
    }
    if (workload.origins !== undefined) {
      if (filter.origin === undefined || !workload.origins.includes(filter.origin)) return false;
    }
    if (filter.suites !== undefined && !filter.suites.includes(workload.suite)) return false;
    if (filter.only !== undefined && !filter.only.some((part) => workload.id.includes(part))) {
      return false;
    }
    return true;
  });
}
