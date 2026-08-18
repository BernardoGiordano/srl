/**
 * The sample loop, inside the page.
 *
 * Node decides how many samples a workload gets and what to do with them; the
 * loop itself runs here, because a round trip over the DevTools protocol per
 * sample would cost more than the workload. ADR-0045.
 *
 * WHAT A WORKLOAD IS
 *
 * Four functions, three of them optional:
 *
 *   prepare(args)          once per page. Import modules, define elements.
 *   setup(scope, args)     once per sample, untimed. Build the fixture.
 *   run(state, scope)      timed. Do the one thing being measured.
 *   check(answer, context)  throws when the answer is wrong.
 *   teardown(state, scope)  untimed. Release anything `scope` cannot.
 *
 * `check` is not optional and not decorative. Every workload here has a cheap
 * observable answer — a row count, a matched path, a rendered cell — and a sample
 * whose answer is wrong is thrown away as a failure rather than reported as a fast
 * run. Enforced twice: here per sample, and again in Node, where `aggregate`
 * refuses a workload with any failed sample. ADR-0045.
 *
 * WHY EACH SAMPLE GETS A FRESH SCOPE
 *
 * `scope` hands out a container that is removed after the sample, with its Lit
 * root explicitly cleared, which is what releases the signal effects a standalone
 * `render()` owns. ADR-0045.
 */

import { nothing, render } from 'lit';

/**
 * @typedef {{
 *   container: HTMLElement,
 *   release: () => void,
 * }} Scope
 *
 * @typedef {{
 *   prepare?: (args: Record<string, unknown>) => Promise<void> | void,
 *   setup?: (scope: Scope, args: Record<string, unknown>) => Promise<unknown> | unknown,
 *   run: (state: any, scope: Scope, args: Record<string, unknown>) => Promise<unknown> | unknown,
 *   check: (answer: any, args: Record<string, unknown>) => void,
 *   teardown?: (state: any, scope: Scope) => Promise<void> | void,
 *   measured?: boolean,
 * }} Workload
 *
 * @typedef {{ duration?: number, metrics?: Record<string, number>, ok: boolean, detail?: string }} Sample
 */

/**
 * Run one workload and return its samples, warmups already discarded.
 *
 * A sample that throws ends the loop: the first failure is the informative one,
 * and thirty repetitions of the same stack are noise in a report somebody has to
 * read.
 *
 * @param {Workload} workload
 * @param {{ samples: number, warmup: number, args?: Record<string, unknown> }} options
 * @returns {Promise<Sample[]>}
 */
export async function runWorkload(workload, options) {
  const args = options.args ?? {};
  /** @type {Sample[]} */
  const samples = [];

  if (workload.prepare !== undefined) await workload.prepare(args);

  const total = options.warmup + options.samples;
  for (let index = 0; index < total; index += 1) {
    const scope = createScope();
    /** @type {unknown} */
    let state;
    /** @type {Sample} */
    let sample;

    try {
      state = workload.setup === undefined ? undefined : await workload.setup(scope, args);
      const started = performance.now();
      const produced = await workload.run(state, scope, args);
      const elapsed = performance.now() - started;

      const answer =
        workload.measured === true
          ? asMeasured(produced)
          : { answer: produced, metrics: undefined };
      workload.check(answer.answer, args);
      sample = { duration: elapsed, metrics: answer.metrics, ok: true };
    } catch (cause) {
      sample = { ok: false, detail: describe(cause) };
    } finally {
      try {
        if (workload.teardown !== undefined) await workload.teardown(state, scope);
      } finally {
        scope.release();
      }
    }

    if (index >= options.warmup || !sample.ok) samples.push(sample);
    if (!sample.ok) break;
    await settle();
  }

  return samples;
}

/**
 * One sample, for the workloads that need a page of their own.
 *
 * Anything that permanently changes the page is in this shape rather than in the
 * loop above: `customElements.define` cannot be undone, so a second sample in the
 * same page would be measuring a registry the first sample filled. Node opens a
 * fresh page per sample and calls this once.
 *
 * @param {Workload} workload
 * @param {{ args?: Record<string, unknown> }} options
 * @returns {Promise<Sample>}
 */
export async function runOnce(workload, options) {
  const samples = await runWorkload(workload, { samples: 1, warmup: 0, args: options.args });
  const first = samples[0];
  if (first === undefined) return { ok: false, detail: 'the workload produced no sample.' };
  return first;
}

/**
 * A measured workload returns its own numbers. Anything else from such a workload
 * is a workload that forgot to, and saying so beats reporting no metric.
 *
 * @param {unknown} produced
 * @returns {{ answer: unknown, metrics: Record<string, number> }}
 */
function asMeasured(produced) {
  const value = /** @type {{ answer?: unknown, metrics?: Record<string, number> }} */ (produced);
  if (value === null || typeof value !== 'object' || typeof value.metrics !== 'object') {
    throw new Error('A measured workload must return { answer, metrics }.');
  }
  return { answer: value.answer, metrics: value.metrics ?? {} };
}

/**
 * @returns {Scope}
 */
function createScope() {
  const container = document.createElement('div');
  document.body.append(container);
  return {
    container,
    release() {
      // The Lit root first: clearing it is what tells async directives to drop
      // their signal effects. Removing the element without it leaves the effects
      // subscribed to signals the next sample will write to.
      render(nothing, container);
      container.remove();
    },
  };
}

/**
 * Let the browser finish what the sample started: a frame for layout and paint,
 * then a task boundary so microtask-scheduled renders land before the next timing
 * begins.
 *
 * @returns {Promise<void>}
 */
export function settle() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(() => resolve(), 0));
  });
}

/**
 * Wait for a Lit element and everything it rendered to be up to date. The
 * benchmark equivalent of the test harness's `settled`, and for the same reason:
 * an assertion or a timing taken before `updateComplete` measures the scheduler.
 *
 * @param {Element} element
 * @returns {Promise<void>}
 */
export async function rendered(element) {
  const updatable = /** @type {{ updateComplete?: Promise<unknown> }} */ (element);
  await updatable.updateComplete;
  for (const child of element.querySelectorAll('*')) {
    const inner = /** @type {{ updateComplete?: Promise<unknown> }} */ (child);
    if (inner.updateComplete !== undefined) await inner.updateComplete;
  }
  await updatable.updateComplete;
}

/**
 * Wait until the DOM says the update landed.
 *
 * Microtasks first, frames second, and that order is the whole point. A signal
 * write reaches the DOM in a microtask, so a workload that waited for a frame
 * would report ~16 ms for a 2 ms update and every framework comparison built on it
 * would be wrong. The frame fallback exists for the updates that genuinely need a
 * task boundary — a `<ui-table>` re-render after a page change — and is entered
 * only once the microtask budget is spent.
 *
 * @param {() => boolean} done
 * @param {string} what
 * @returns {Promise<void>}
 */
export async function waitFor(done, what) {
  for (let turn = 0; turn < 5000; turn += 1) {
    if (done()) return;
    await Promise.resolve();
  }
  for (let frame = 0; frame < 120; frame += 1) {
    if (done()) return;
    await settle();
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

/**
 * Assert, with the value in the message. Workload checks are read in a terminal
 * report, so "expected 500 rows, rendered 50" has to survive without a stack.
 *
 * @param {unknown} actual
 * @param {unknown} expected
 * @param {string} what
 */
export function expect(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${format(expected)}, got ${format(actual)}`);
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function format(value) {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

/**
 * @param {unknown} cause
 * @returns {string}
 */
function describe(cause) {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  return String(cause);
}

/* ── Fixture data ──────────────────────────────────────────────────────────
 *
 * Shared rather than per workload so that a filter workload and a render workload
 * at the same row count are working on the same shape of data. Deterministic, and
 * seeded from the index rather than from a random source: two runs of the same
 * workload must do the same amount of work, or the p95 is measuring the fixture.
 */

/**
 * @typedef {{
 *   id: number,
 *   name: string,
 *   email: string,
 *   team: string,
 *   role: string,
 *   salary: number,
 *   active: boolean,
 *   meta: { team: string, city: string },
 * }} Row
 */

const TEAMS = ['Core', 'Web', 'Data', 'Ops', 'Design'];
const CITIES = ['Milano', 'Roma', 'Torino', 'Napoli', 'Bologna'];
const ROLES = ['engineer', 'manager', 'analyst', 'designer'];

/**
 * @param {number} count
 * @returns {Row[]}
 */
export function makeRows(count) {
  /** @type {Row[]} */
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const team = /** @type {string} */ (TEAMS[index % TEAMS.length]);
    const city = /** @type {string} */ (CITIES[index % CITIES.length]);
    rows.push({
      id: index + 1,
      name: `Person ${String(index + 1)}`,
      email: `person${String(index + 1)}@example.test`,
      team,
      role: /** @type {string} */ (ROLES[index % ROLES.length]),
      salary: 30_000 + (index % 50) * 900,
      active: index % 3 !== 0,
      meta: { team, city },
    });
  }
  return rows;
}
