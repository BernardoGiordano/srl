/**
 * Memory and lifecycle workloads.
 *
 * Everything here answers one question: does releasing something actually release
 * it? The plan's exit criterion is "no monotonic retained-node or retained-listener
 * growth", and monotonic is the operative word — a single before/after pair cannot
 * tell a leak from a page that grew once and stayed put. So each sample runs its
 * cycles in batches and reads three counters between them, and a sample whose
 * counters climb in every batch fails no matter how fast it was.
 *
 * The counters come from the DevTools protocol, after two forced collections: used
 * JavaScript heap, retained DOM nodes, retained event listeners. Forcing collection
 * is confined to these workloads. Doing it inside a timed loop elsewhere would
 * measure the collector, which is the mistake that makes most homegrown memory
 * benchmarks unreadable.
 */

/** @import { BenchmarkSample, BenchmarkPage, NodeWorkloadContext, WorkloadSpec } from '../types.js' */

/** How many batches each cycle workload is split into, for the growth check. */
const BATCHES = 5;

/**
 * Growth this side of noise is not a leak. A page that has run one batch has caches
 * a second batch reuses, and a handful of nodes either way is the renderer's own
 * bookkeeping.
 */
const NODE_NOISE = 200;
const LISTENER_NOISE = 20;

/**
 * @typedef {{ heap: number, nodes: number, listeners: number }} Counters
 */

/**
 * @param {BenchmarkPage} page
 * @returns {Promise<Counters>}
 */
async function counters(page) {
  const heap = await page.heap();
  const retained = await page.retained();
  return { heap, nodes: retained.nodes, listeners: retained.listeners };
}

/**
 * Call one export of the lifecycle module in the page.
 *
 * @template T
 * @param {BenchmarkPage} page
 * @param {string} name
 * @param {number} argument
 * @returns {Promise<T>}
 */
function callLifecycle(page, name, argument) {
  return page.evaluate(
    `async (count) => {
      const module = await import('/__benchmark/lifecycle.js');
      return module[${JSON.stringify(name)}](count);
    }`,
    argument,
  );
}

/**
 * Strictly increasing in every batch, and increasing by more than noise overall.
 *
 * Both halves are needed. Strict monotonicity alone flags a page that grew by three
 * nodes a batch; a total-growth threshold alone flags a page that allocated a cache
 * once and then held steady, which is not a leak.
 *
 * @param {readonly number[]} series
 * @param {number} noise
 * @returns {boolean}
 */
function leaks(series, noise) {
  const first = series[0];
  const last = series[series.length - 1];
  if (first === undefined || last === undefined) return false;
  if (last - first <= noise) return false;
  return series.every((value, index) => index === 0 || value > /** @type {number} */ (series[index - 1]));
}

/**
 * One sample: `cycles` mount/release cycles of one kind, in batches, with counters
 * between them.
 *
 * @param {NodeWorkloadContext} context
 * @param {{ name: string, cycles: number, expect: (answer: any) => string | undefined }} options
 * @returns {Promise<BenchmarkSample>}
 */
async function cycleSample(context, options) {
  const page = await context.browser.harnessPage();
  try {
    const before = await counters(page);
    /** @type {Counters[]} */
    const series = [];
    const perBatch = Math.max(1, Math.round(options.cycles / BATCHES));
    const started = Date.now();

    for (let batch = 0; batch < BATCHES; batch += 1) {
      const answer = await callLifecycle(page, options.name, perBatch);
      const wrong = options.expect(answer);
      if (wrong !== undefined) return { ok: false, detail: wrong };
      series.push(await counters(page));
    }

    const elapsed = Date.now() - started;
    const last = /** @type {Counters} */ (series[series.length - 1]);
    const errors = page.errors();
    if (errors.length > 0) return { ok: false, detail: `the page reported errors: ${errors.join(' | ')}` };

    if (leaks(series.map((entry) => entry.nodes), NODE_NOISE)) {
      return {
        ok: false,
        detail: `retained DOM nodes grew in every batch: ${series.map((entry) => entry.nodes).join(' -> ')}`,
      };
    }
    if (leaks(series.map((entry) => entry.listeners), LISTENER_NOISE)) {
      return {
        ok: false,
        detail: `retained listeners grew in every batch: ${series.map((entry) => entry.listeners).join(' -> ')}`,
      };
    }

    return {
      ok: true,
      duration: elapsed,
      metrics: {
        heapGrowthBytes: last.heap - before.heap,
        nodeGrowth: last.nodes - before.nodes,
        listenerGrowth: last.listeners - before.listeners,
        cycles: perBatch * BATCHES,
      },
    };
  } finally {
    await page.close();
  }
}

/**
 * @param {NodeWorkloadContext} context
 * @param {{ name: string, cycles: number, expect: (answer: any) => string | undefined }} options
 * @returns {Promise<BenchmarkSample[]>}
 */
async function repeatCycles(context, options) {
  /** @type {BenchmarkSample[]} */
  const samples = [];
  for (let index = 0; index < context.warmup + context.samples; index += 1) {
    const sample = await cycleSample(context, options);
    if (index >= context.warmup || !sample.ok) samples.push(sample);
    if (!sample.ok) break;
  }
  return samples;
}

/**
 * Mount a full table, read the heap while it is mounted, release it, collect, and
 * read the heap again.
 *
 * The two figures the first measurements reported (ADR-0037), now with a stated
 * sample count. `recovered` is
 * the derived one that matters: heap after release, against the baseline taken
 * before anything was mounted.
 *
 * @param {NodeWorkloadContext} context
 * @param {number} rows
 * @returns {Promise<BenchmarkSample[]>}
 */
async function tableHeapSamples(context, rows) {
  /** @type {BenchmarkSample[]} */
  const samples = [];

  for (let index = 0; index < context.warmup + context.samples; index += 1) {
    const page = await context.browser.harnessPage();
    /** @type {BenchmarkSample} */
    let sample;
    try {
      const baseline = await page.heap();
      const started = Date.now();
      const mounted = /** @type {{ peakCells: number, renderedRows: number }} */ (
        await callLifecycle(page, 'mountTable', rows)
      );
      const mountedHeap = await page.heap();
      const released = /** @type {{ remainingRows: number, remainingContainers: number }} */ (
        await callLifecycle(page, 'releaseTable', 0)
      );
      const afterHeap = await page.heap();
      const elapsed = Date.now() - started;

      if (mounted.renderedRows !== rows) {
        sample = {
          ok: false,
          detail: `mounted ${String(mounted.renderedRows)} of ${String(rows)} rows`,
        };
      } else if (released.remainingRows !== 0 || released.remainingContainers !== 0) {
        sample = { ok: false, detail: 'the released table left rows in the document' };
      } else {
        sample = {
          ok: true,
          duration: elapsed,
          metrics: {
            mountedHeapBytes: mountedHeap - baseline,
            recoveredHeapBytes: afterHeap - baseline,
            cells: mounted.peakCells,
          },
        };
      }
    } finally {
      await page.close();
    }

    if (index >= context.warmup || !sample.ok) samples.push(sample);
    if (!sample.ok) break;
  }

  return samples;
}

/** @type {WorkloadSpec[]} */
export const MEMORY_WORKLOADS = [
  {
    id: 'memory/route-cycles',
    suite: 'memory',
    title: 'Fifty route mount and release cycles',
    driver: 'node',
    samples: { local: 3, ci: 2 },
    warmup: { local: 1, ci: 0 },
    units: {
      duration: 'ms',
      heapGrowthBytes: 'bytes',
      nodeGrowth: 'count',
      listenerGrowth: 'count',
      cycles: 'count',
    },
    run: (context) =>
      repeatCycles(context, {
        name: 'routeCycles',
        cycles: 50,
        expect: (answer) =>
          answer?.leftBehind === 0
            ? undefined
            : `a released route chain left ${String(answer?.leftBehind)} views in the document`,
      }),
  },
  {
    id: 'memory/outlet-swaps',
    suite: 'memory',
    title: 'Fifty outlet swaps whose first target loses the race',
    driver: 'node',
    samples: { local: 3, ci: 2 },
    warmup: { local: 1, ci: 0 },
    units: {
      duration: 'ms',
      heapGrowthBytes: 'bytes',
      nodeGrowth: 'count',
      listenerGrowth: 'count',
      cycles: 'count',
    },
    run: (context) =>
      repeatCycles(context, {
        name: 'outletSwaps',
        cycles: 50,
        expect: (answer) =>
          answer?.mounted === 'cycle-view' && answer?.children === 1
            ? undefined
            : `the outlet held ${String(answer?.children)} children, mounted ${String(answer?.mounted)}`,
      }),
  },
  {
    id: 'memory/table-10000',
    suite: 'memory',
    title: 'Heap while 10,000 rows are mounted, and after release',
    driver: 'node',
    samples: { local: 3, ci: 2 },
    warmup: { local: 1, ci: 0 },
    units: {
      duration: 'ms',
      mountedHeapBytes: 'bytes',
      recoveredHeapBytes: 'bytes',
      cells: 'count',
    },
    run: (context) => tableHeapSamples(context, 10_000),
  },
];
