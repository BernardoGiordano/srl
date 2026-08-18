/**
 * The reference workloads: how fast is this machine right now.
 *
 * WHY A BENCHMARK NEEDS THEM
 *
 * Two runs on a developer machine do not get the same computer, so each run measures
 * fixed work no change to this repository can affect and comparisons are scaled by
 * how much slower or faster that work got. ADR-0043.
 *
 * WHY TWO OF THEM
 *
 * A reference can only normalise work of its own kind — an arithmetic loop reports
 * an interactive desktop as unchanged while every render workload is halved:
 *
 *   `reference`        integer and float arithmetic, no allocation, no DOM. The CPU
 *                      clock, and nothing else.
 *   `layoutReference`  build a few thousand styled elements and force one layout.
 *                      The renderer's throughput: allocation, style, layout, and
 *                      whatever else is competing for the machine.
 *
 * Both are reported in every result file, both are re-measured at the end of a run,
 * and `tools/benchmark/measure.mjs` picks the one that matches the suite it is
 * comparing. Neither touches a line of repository source, which is what makes a
 * change in either one environmental by construction.
 *
 * WHAT THEY DELIBERATELY ARE NOT
 *
 * Not a proxy for disk, network or a child process. That is the known limit of the
 * approach rather than a bug in it, and it is why the tooling suite carries a much
 * wider threshold instead. ADR-0043.
 *
 * Neither loop may ever be tuned. Changing one invalidates every baseline ever
 * recorded, because a scale factor is only meaningful against identical work.
 */

import { expect } from './support.js';

/**
 * Iterations per sample. Fixed; see the note above.
 *
 * Sized so a sample lands in the tens of milliseconds — measured at 24 ms here. The
 * first version ran 2,000,000 iterations and measured 1.9 ms, which is 19 ticks of a
 * clock Chrome quantises to 100 µs: one tick of jitter moved the scale factor by 5%
 * and every workload's comparison with it. A few hundred ticks of reference work cost
 * a third of a second per run and make the factor a measurement instead of a rounding.
 */
const ITERATIONS = 32_000_000;

/**
 * @type {import('./support.js').Workload}
 */
export const reference = {
  run() {
    let total = 0;
    for (let index = 1; index <= ITERATIONS; index += 1) {
      // Data-dependent so nothing can be hoisted, and finite so the answer is a
      // constant the check can pin.
      total += Math.sqrt(index) + (index % 7) * 0.5;
    }
    return Math.round(total);
  },

  check(answer) {
    // The same arithmetic always produces the same number. If it does not, the loop
    // was changed and every baseline that used it is invalid.
    expect(answer, 120_727_560_150, 'the reference sum');
  },
};

/**
 * Rows per sample of the layout reference. Fixed, for the same reason as `ITERATIONS`,
 * and sized to the same tens-of-milliseconds range: measured at 21.5 ms here.
 */
const LAYOUT_ROWS = 6_000;

/**
 * The renderer-side reference: build DOM, style it, lay it out once.
 *
 * Deliberately built from `document.createElement` and inline styles rather than from
 * a template or an element in this repository, so that nothing a later phase changes
 * can move this number. The forced layout is the point: every read happens after
 * every write, so the cost is one layout pass over 4,000 boxes rather than 4,000
 * interleaved reflows, which is the shape the real render workloads have too.
 *
 * @type {import('./support.js').Workload}
 */
export const layoutReference = {
  run(_state, scope) {
    const root = document.createElement('div');
    for (let index = 0; index < LAYOUT_ROWS; index += 1) {
      const row = document.createElement('div');
      row.style.padding = '1px 2px';
      row.style.borderBottom = '1px solid #cccccc';
      row.style.fontSize = '12px';
      row.textContent = `reference row ${String(index)}`;
      root.append(row);
    }
    scope.container.append(root);

    let laidOut = 0;
    for (const child of root.children) {
      if (/** @type {HTMLElement} */ (child).offsetHeight > 0) laidOut += 1;
    }
    return laidOut;
  },

  check(answer) {
    // Every row has text and is a block, so every row has height. A zero here means
    // the page was not rendering, and a number measured in a page that is not
    // rendering is not a measurement of layout.
    expect(answer, LAYOUT_ROWS, 'the reference row count');
  },
};
