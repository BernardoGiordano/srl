/**
 * Test harness.
 *
 * Hand-written rather than pulling in @open-wc/testing or chai, because those are
 * bare specifiers and resolving them would mean turning on the dev server's
 * node-resolve. That rewrites bare specifiers to node_modules paths before the
 * import map ever sees them, so `lit` in a test would resolve to a different
 * artifact than `lit` in production. Tests that run against different bytes than
 * the app are worth less than an assertion helper is worth writing.
 *
 * Mocha's globals (describe/it/beforeEach) are injected by @web/test-runner and
 * need no import.
 */

/**
 * When a render is finished is not this file's rule to keep. `settled` walks the
 * element and everything it rendered, and the router awaits the same module, so a
 * suite and the framework cannot disagree about what "rendered" means. ADR-0079.
 */
export { settled } from '@core/elements/settled.js';

/** @type {HTMLElement | null} */
let container = null;

/**
 * Tests run under Trusted Types enforcement. `mount()` accepts only static test
 * fixture strings, so its narrowly allow-listed policy keeps fixture setup from
 * obscuring whether production sinks are compliant.
 *
 * @typedef {{ createHTML(value: string): unknown }} TestPolicy
 * @typedef {{ createPolicy(name: string, rules: { createHTML(value: string): string }): TestPolicy }} TestPolicyFactory
 */
const testPolicyFactory = /** @type {{ trustedTypes?: TestPolicyFactory }} */ (
  /** @type {unknown} */ (globalThis)
).trustedTypes;
const testPolicy = testPolicyFactory?.createPolicy('test-harness', {
  createHTML: (value) => value,
});

/** @param {string} markup @returns {string} */
function trustedFixture(markup) {
  return /** @type {string} */ (
    /** @type {unknown} */ (testPolicy?.createHTML(markup) ?? markup)
  );
}

/**
 * Mount an element for the duration of one test. Torn down automatically.
 *
 * @template {HTMLElement} T
 * @param {string} markup
 * @returns {T}
 */
export function mount(markup) {
  container ??= document.createElement('div');
  if (!container.isConnected) document.body.append(container);
  container.innerHTML = trustedFixture(markup);
  const first = container.firstElementChild;
  if (first === null) throw new Error('mount() produced no element.');
  return /** @type {T} */ (first);
}

/** Remove anything mount() put in the document. */
export function unmountAll() {
  container?.remove();
  if (container !== null) container.innerHTML = trustedFixture('');
  container = null;
}

/**
 * Assert a value exists and return it narrowed.
 *
 * A method on an object literal cannot serve as a TypeScript assertion function
 * (assertions require the call target to carry an explicit type annotation), so
 * `assert.ok(x)` does not narrow `x`. Returning the value does the same job with
 * no declaration gymnastics: `const el = present(root.querySelector('.x'))`.
 *
 * @template T
 * @param {T | null | undefined} value
 * @param {string} [message]
 * @returns {T}
 */
export function present(value, message) {
  if (value === null || value === undefined) {
    throw new Error(message ?? 'Expected a value, found none.');
  }
  return value;
}

/* ── Assertions ────────────────────────────────────────────────────────── */

export const assert = {
  /**
   * @param {unknown} actual
   * @param {unknown} expected
   * @param {string} [message]
   */
  equal(actual, expected, message) {
    if (actual !== expected) {
      throw new Error(
        `${message ?? 'Not equal'}\n  expected: ${format(expected)}\n  actual:   ${format(actual)}`,
      );
    }
  },

  /**
   * @param {unknown} value
   * @param {string} [message]
   */
  ok(value, message) {
    if (!value) throw new Error(`${message ?? 'Expected truthy'}, got ${format(value)}`);
  },

  /**
   * @param {unknown} value
   * @param {string} [message]
   */
  notOk(value, message) {
    if (value) throw new Error(`${message ?? 'Expected falsy'}, got ${format(value)}`);
  },

  /**
   * @param {readonly unknown[]} actual
   * @param {readonly unknown[]} expected
   * @param {string} [message]
   */
  sameArray(actual, expected, message) {
    const same =
      actual.length === expected.length && actual.every((value, i) => value === expected[i]);
    if (!same) {
      throw new Error(
        `${message ?? 'Arrays differ'}\n  expected: ${format(expected)}\n  actual:   ${format(actual)}`,
      );
    }
  },

  /**
   * @param {string} haystack
   * @param {string} needle
   * @param {string} [message]
   */
  includes(haystack, needle, message) {
    if (!haystack.includes(needle)) {
      throw new Error(`${message ?? 'Missing substring'}: ${format(needle)} not in ${format(haystack)}`);
    }
  },

  /**
   * @param {() => unknown} run
   * @param {string} [expectedMessage]
   */
  throws(run, expectedMessage) {
    let threw = false;
    try {
      run();
    } catch (cause) {
      threw = true;
      if (expectedMessage !== undefined) {
        const actual = cause instanceof Error ? cause.message : String(cause);
        if (!actual.includes(expectedMessage)) {
          throw new Error(`Wrong error.\n  expected to include: ${expectedMessage}\n  actual: ${actual}`);
        }
      }
    }
    if (!threw) throw new Error('Expected a throw, none occurred.');
  },

  /**
   * @param {() => Promise<unknown>} run
   * @param {string} [expectedMessage]
   * @returns {Promise<void>}
   */
  async rejects(run, expectedMessage) {
    let threw = false;
    try {
      await run();
    } catch (cause) {
      threw = true;
      if (expectedMessage !== undefined) {
        const actual = cause instanceof Error ? cause.message : String(cause);
        if (!actual.includes(expectedMessage)) {
          throw new Error(`Wrong rejection.\n  expected to include: ${expectedMessage}\n  actual: ${actual}`);
        }
      }
    }
    if (!threw) throw new Error('Expected a rejection, none occurred.');
  },
};

/**
 * @param {unknown} value
 * @returns {string}
 */
function format(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value instanceof Element) return value.outerHTML;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
