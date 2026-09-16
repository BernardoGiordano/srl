/**
 * The browser engines a journey runs on, and the thin driver each one answers through.
 *
 * There are three of them and one of everything else. An engine adapter here may
 * navigate, press a real key, evaluate the observer and report its version, and
 * nothing more. Every judgement about what a running application looks like belongs to
 * `observer.mjs`, and every judgement about what the application should do belongs to
 * `journey.mjs`. ADR-0116. A driver that grew a `selectRow()` would be the
 * browser-compatibility layer this arrangement exists to avoid, because the same
 * expectation would then be written three times and could quietly mean three things.
 *
 * The keys are real. `element.focus()` and `element.click()` are the application
 * calling itself, and a keyboard event synthesised in the page skips the part every
 * engine implements differently, such as default actions, focus order and what a
 * native `<dialog>` does with focus when it closes. The journey presses keys through
 * the driver, and reaches into the page only to put focus somewhere a pointerless user
 * could have put it.
 *
 * The origin is the only origin. Every request to anywhere else is refused, in every
 * engine, by the same route handler. The built artifact is self-contained by
 * construction, and a journey that silently reached a CDN would be proving something
 * about the network rather than about the bytes.
 */

import { chromium, firefox, webkit } from 'playwright';

import { OBSERVER_SOURCE } from './observer.mjs';

/**
 * The engines the journey declares, in the order the support matrix lists them.
 *
 * `id` is what a record and a `--engine` argument name. `engine` is the rendering
 * engine, which is what a support claim is actually about, so "Chrome and Edge" is one
 * entry here rather than two.
 *
 * `nextControl` is the one per-engine fact in this file, and it is a platform setting
 * rather than a workaround. WebKit ships with full keyboard access off, so plain Tab
 * moves between links and text fields only and skips a checkbox entirely. Option+Tab
 * is the documented way to reach every control, and it is what a Safari user with the
 * default settings actually presses. Recording it beats hiding it, so the support
 * matrix says which key each engine needed and a reader can see that one of them needs
 * a different one.
 *
 * @type {ReadonlyArray<{ id: string, title: string, engine: string, nextControl: string, browser: import('playwright').BrowserType }>}
 */
export const ENGINES = [
  { id: 'chromium', title: 'Chromium', engine: 'Blink', nextControl: 'Tab', browser: chromium },
  { id: 'firefox', title: 'Firefox', engine: 'Gecko', nextControl: 'Tab', browser: firefox },
  { id: 'webkit', title: 'WebKit', engine: 'WebKit', nextControl: 'Alt+Tab', browser: webkit },
];

/**
 * @param {string} id
 * @returns {(typeof ENGINES)[number]}
 */
export function engineById(id) {
  const found = ENGINES.find((engine) => engine.id === id);
  if (found === undefined) {
    throw new Error(`Unknown engine ${id}. Declared: ${ENGINES.map((e) => e.id).join(', ')}.`);
  }
  return found;
}

/** @import { Observations } from './types.js' */

/**
 * What a journey may do and see. Everything below `type` is the observable interaction
 * interface; everything above it is the four ways a journey may act on a page.
 *
 * @typedef {{
 *   id: string,
 *   title: string,
 *   engine: string,
 *   version: string,
 *   nextControl: string,
 *   goto: (path: string) => Promise<void>,
 *   press: (key: string, times?: number) => Promise<void>,
 *   advance: (times?: number) => Promise<void>,
 *   retreat: (times?: number) => Promise<void>,
 *   type: (value: string) => Promise<void>,
 *   observe: <K extends keyof Observations>(name: K, ...args: unknown[]) => Promise<Observations[K]>,
 *   until: <K extends keyof Observations>(
 *     name: K,
 *     args: unknown[],
 *     accept: (value: NonNullable<Observations[K]>) => boolean,
 *     what: string,
 *   ) => Promise<NonNullable<Observations[K]>>,
 *   errors: () => readonly string[],
 *   close: () => Promise<void>,
 * }} Driver
 */

/** How long a journey waits for a screen to reach a state before calling it a failure. */
const SETTLE_TIMEOUT_MS = 15_000;

/** The gap between readings while waiting. Short enough to be a poll, long enough to be cheap. */
const POLL_MS = 50;

/**
 * Launch one engine against one origin and hand back the driver the journey speaks to.
 *
 * @param {(typeof ENGINES)[number]} engine
 * @param {string} origin
 * @returns {Promise<Driver>}
 */
export async function openEngine(engine, origin) {
  const browser = await engine.browser.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

  /** @type {string[]} */
  const errors = [];

  // Nothing but the artifact's own origin. A refusal is recorded rather than swallowed,
  // because a journey that passes while a request is being denied is not passing.
  await context.route('**/*', async (route, request) => {
    if (request.url().startsWith(origin)) {
      await route.continue();
      return;
    }
    errors.push(`off-origin request refused: ${request.url()}`);
    await route.abort();
  });

  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('requestfailed', (request) => {
    const failure = request.failure();
    if (failure !== null && !failure.errorText.includes('ERR_ABORTED')) {
      errors.push(`${request.url()}: ${failure.errorText}`);
    }
  });

  // Installed over the protocol rather than as a `<script>`, because the entry
  // document is served with the artifact's own `script-src 'self'` and leaving that
  // policy alone is half the reason for driving the built bytes at all.
  await page.addInitScript({ content: `void ${OBSERVER_SOURCE};` });

  /**
   * @param {string} name
   * @param {unknown[]} args
   * @returns {Promise<unknown>}
   */
  const observe = (name, ...args) =>
    page.evaluate(
      ([called, passed]) => {
        const journey = /** @type {Record<string, ((...rest: unknown[]) => unknown) | undefined>} */ (
          /** @type {{ __journey?: unknown }} */ (globalThis).__journey
        );
        if (journey === undefined) throw new Error('the journey observer is not installed');
        const reading = journey[/** @type {string} */ (called)];
        if (reading === undefined) throw new Error(`no journey observation named ${String(called)}`);
        return reading(.../** @type {unknown[]} */ (passed));
      },
      /** @type {[string, unknown[]]} */ ([name, args]),
    );

  /**
   * @param {string} key
   * @param {number} times
   */
  const press = async (key, times = 1) => {
    for (let count = 0; count < times; count += 1) await page.keyboard.press(key);
  };

  return {
    id: engine.id,
    title: engine.title,
    engine: engine.engine,
    version: browser.version(),
    nextControl: engine.nextControl,

    async goto(path) {
      await page.goto(`${origin}${path}`, { waitUntil: 'load', timeout: 30_000 });
    },

    press,

    /** Forward to the next focusable control, by whichever key this engine reaches one with. */
    advance: (times = 1) => press(engine.nextControl, times),

    /** The same move backwards. */
    retreat: (times = 1) => press(`Shift+${engine.nextControl}`, times),

    async type(value) {
      await page.keyboard.type(value, { delay: 10 });
    },

    observe: /** @type {Driver['observe']} */ (/** @type {unknown} */ (observe)),

    /**
     * Read one observation until it says what the journey is waiting for.
     *
     * A journey has no clock of its own and no `waitForSelector`. What it waits for
     * is a reading of the page it already knows how to take, which keeps the waiting
     * in the same vocabulary as the assertion that follows it.
     */
    until: /** @type {Driver['until']} */ (/** @type {unknown} */ (async (
      /** @type {string} */ name,
      /** @type {unknown[]} */ args,
      /** @type {(value: never) => boolean} */ accept,
      /** @type {string} */ what,
    ) => {
      const deadline = Date.now() + SETTLE_TIMEOUT_MS;
      let last;
      for (;;) {
        last = await observe(name, ...args);
        if (last !== null && accept(/** @type {never} */ (last))) return last;
        if (Date.now() > deadline) {
          throw new Error(
            `${engine.title}: timed out waiting for ${what}. Last reading: ${JSON.stringify(last)}.` +
              (errors.length === 0 ? '' : ` Page errors: ${errors.join(' | ')}`),
          );
        }
        await new Promise((resume) => setTimeout(resume, POLL_MS));
      }
    })),

    errors: () => errors,

    async close() {
      await context.close();
      await browser.close();
    },
  };
}
