/**
 * Test helpers for the page's pin table. ADR-0129.
 *
 * The browser reads the import map once, at load. `@core/foundation/pins.js` reads the
 * element's text on every lookup, so a test can add pins for its own fixtures without
 * changing how any module resolves. The text is swapped as a node, because the test
 * page requires Trusted Types for script text and the map never runs again.
 */

/**
 * Run `body` while the page's import map also pins `pins`, then restore the map.
 *
 * @template T
 * @param {Readonly<Record<string, string>>} pins
 * @param {() => T | Promise<T>} body
 * @returns {Promise<T>}
 */
export async function withPagePins(pins, body) {
  const script = document.querySelector('script[type="importmap"]');
  if (script === null) throw new Error('The test page has no import map.');
  const original = script.textContent ?? '';
  /** @type {unknown} */
  const parsed = JSON.parse(original);
  const map = /** @type {{ integrity?: Record<string, string> }} */ (parsed);
  const text = JSON.stringify({ ...map, integrity: { ...map.integrity, ...pins } });
  script.replaceChildren(document.createTextNode(text));
  try {
    return await body();
  } finally {
    script.replaceChildren(document.createTextNode(original));
  }
}

/**
 * The `sha384` pin of the bytes a URL serves.
 *
 * @param {string} url
 * @returns {Promise<string>}
 */
export async function pinOf(url) {
  const bytes = await (await fetch(url)).arrayBuffer();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-384', bytes));
  return `sha384-${btoa(String.fromCharCode(...digest))}`;
}
