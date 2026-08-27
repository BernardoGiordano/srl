/**
 * When a render is finished.
 *
 * One rule, in one module, because a dozen places had written it. The router
 * waits for a layout to render before it looks for the outlet inside it. The test
 * harness waits before asserting. A router suite walked a mounted chain level by
 * level. Nine component suites each declared a local `ready()` that re-derived a
 * subtree walk, and no two of the nine agreed: some awaited every descendant,
 * some named two tag names, some settled the root twice and stopped.
 *
 * A dozen spellings of "finished" is how they disagree, and the one that is wrong
 * is the one whose assertion goes flaky on a slower machine. ADR-0079.
 *
 * Nothing here reads a clock or waits for a frame. Both exports resolve on the
 * element's own promises, so a suite that awaits them is not waiting on wall-clock
 * time — see `@core/foundation/clock.js` for the scheduled work that is.
 */

/**
 * Wait until one element has finished rendering, including a render its first one
 * scheduled.
 *
 * One `updateComplete` is not enough: a component that projects content puts its
 * children back at the end of *its own* first render, which its parent's update
 * only schedules, so a `<main>` authored inside `<ui-app-shell>` does not exist
 * yet when the shell's update completes. One more turn, then the host's
 * completion again, covers it.
 *
 * An element with no `updateComplete` is not an error and not a no-op: awaiting
 * `undefined` still yields the three microtask turns, which is what the harness
 * has always done and what a caller holding a plain element expects.
 *
 * @param {Element} element
 * @returns {Promise<void>}
 */
export async function whenRendered(element) {
  const updatable = /** @type {{ updateComplete?: Promise<unknown> }} */ (
    /** @type {unknown} */ (element)
  );

  await updatable.updateComplete;
  await Promise.resolve();
  await updatable.updateComplete;
}

/**
 * How many times `settled` will look for descendants that were not there last
 * time. A stable subtree needs two passes: one that waits for what it finds, one
 * that finds nothing new. Anything approaching this limit is a component that
 * grows the tree on every update, and hanging is a worse way to learn that than
 * the error below.
 */
const PASS_LIMIT = 50;

/**
 * Wait until an element and everything it rendered have finished.
 *
 * The walk repeats rather than sweeping once, because a level's children only
 * exist after that level has rendered: a routed chain reveals one layout at a
 * time, and a single pass over `querySelectorAll('*')` would return before the
 * deepest view was ever in the document. Each pass waits for the descendants it
 * has not waited for yet; when a pass finds none, the subtree has stopped growing
 * and the root's own render is awaited once more.
 *
 * Only elements with an `updateComplete` are waited for. A plain `<div>` has
 * nothing pending, and three microtask turns each across a table's worth of cells
 * is measurable for no gain.
 *
 * @param {Element} element
 * @returns {Promise<void>}
 */
export async function settled(element) {
  await whenRendered(element);

  /** @type {Set<Element>} */
  const walked = new Set();

  for (let pass = 0; pass < PASS_LIMIT; pass += 1) {
    const pending = [...element.querySelectorAll('*')].filter(
      (node) =>
        !walked.has(node) &&
        /** @type {{ updateComplete?: Promise<unknown> }} */ (
          /** @type {unknown} */ (node)
        ).updateComplete !== undefined,
    );

    if (pending.length === 0) {
      await whenRendered(element);
      return;
    }

    for (const node of pending) {
      walked.add(node);
      await whenRendered(node);
    }
  }

  throw new Error(
    `settled(<${element.localName}>) ran ${PASS_LIMIT} passes and the subtree was still ` +
      `producing elements to wait for. Something in it renders a new element every time ` +
      `it updates, so there is no point at which it is finished.`,
  );
}
