/**
 * When a render is finished. The router and the test harness share this one
 * definition. ADR-0079.
 *
 * Both exports wait on the element's own promises, never on a clock or a frame.
 */

/**
 * Wait until one element finishes rendering, including a render its first one
 * schedules.
 *
 * A projecting component puts its children back at the end of its own first render,
 * after its parent's update has completed. One more turn and a second
 * `updateComplete` cover that.
 *
 * A plain element without `updateComplete` still gets the microtask turns.
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
 * Passes `settled` makes before it gives up. A stable subtree needs two. Reaching the
 * limit means something adds an element on every update.
 */
const PASS_LIMIT = 50;

/**
 * Wait until an element and everything it rendered have finished.
 *
 * Each pass waits for updatable descendants it hasn't seen yet. A routed chain
 * reveals one level at a time, so one pass isn't enough. When a pass finds nothing
 * new, the root's render is awaited once more. Plain elements are skipped.
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
