/**
 * The Chrome the harness measures in.
 *
 * A benchmark needs to own the sample loop, collect garbage and read a heap, and
 * @web/test-runner offers none of the three, which is why this is not a test-runner
 * plugin. ADR-0045. Both halves still run the same source over one origin, which is
 * the property that matters.
 *
 * The network is blocked at the network stack rather than by request interception,
 * which would disable Chrome's cache and make a warm start meaningless. Two flags
 * leave caching untouched:
 *
 *   --host-resolver-rules  every host but the loopback fails to resolve
 *   --proxy-server         anything that got past that has nowhere to go
 *
 * A workload that reaches for a CDN therefore fails rather than quietly measuring
 * somebody's edge cache, and `offOrigin()` reports what it tried, so the failure
 * names the URL instead of a timeout.
 *
 * Beyond evaluating a workload, a page here can collect garbage and read the
 * JavaScript heap, and count the DOM nodes and listeners the renderer is holding.
 * Those are the three capabilities the memory and lifecycle workloads are built out
 * of, and none of them is reachable from inside a page. `performance.memory` is
 * coarse, quantised and clamped, and there is no counter for retained listeners at
 * all.
 */

import { Launcher } from 'chrome-launcher';
import puppeteer from 'puppeteer-core';

import { HARNESS_PATH } from './origin.mjs';

/** @import { BenchmarkPage, NetworkConditions, RequestRecord } from './types.js' */
/** @import { Browser, CDPSession } from 'puppeteer-core' */

/**
 * Flags chosen for a measurement rather than for a session a human uses.
 *
 * The throttling ones matter most. A headless page that Chrome decides is
 * backgrounded gets its timers clamped to once a second, which turns a 30-sample
 * workload into a 30-second one and its p95 into fiction.
 *
 * @param {string} originUrl
 * @returns {string[]}
 */
function launchFlags(originUrl) {
  const host = new URL(originUrl).hostname;
  return [
    '--js-flags=--expose-gc',
    `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${host}`,
    '--proxy-server=http://127.0.0.1:1',
    `--proxy-bypass-list=${host}`,
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=BackForwardCache,Translate',
    '--disable-extensions',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--mute-audio',
    '--window-size=1280,900',
  ];
}

/**
 * Launch Chrome, or fail with the reason and what to do about it.
 *
 * The executable is the one @web/test-runner would have used, found by
 * chrome-launcher, so the browser tests and the benchmarks report on the same binary.
 * A missing Chrome is an environment failure and says so, because silently reporting
 * no results is how a benchmark gate stops being a gate.
 *
 * @param {{ originUrl: string }} options
 * @returns {Promise<{
 *   version: string,
 *   harnessPage: () => Promise<BenchmarkPage>,
 *   load: (
 *     path: string,
 *     options?: { cache?: boolean, init?: string, network?: NetworkConditions },
 *   ) => Promise<BenchmarkPage>,
 *   close: () => Promise<void>,
 * }>}
 */
export async function launchBrowser({ originUrl }) {
  const executablePath = findChrome();

  /** @type {Browser} */
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: launchFlags(originUrl),
      protocolTimeout: 180_000,
    });
  } catch (cause) {
    throw new Error(
      `Chrome at ${executablePath} could not be launched, so no browser workload can run: ` +
        `${String(cause)}`,
    );
  }

  const version = (await browser.version()).replace(/^HeadlessChrome\//u, '');

  return {
    version,
    harnessPage: () => openPage(browser, originUrl, HARNESS_PATH, {}),
    load: (path, options) => openPage(browser, originUrl, path, options ?? {}),
    close: () => browser.close(),
  };
}

/**
 * @returns {string}
 */
function findChrome() {
  /** @type {string[]} */
  let installations = [];
  try {
    installations = Launcher.getInstallations();
  } catch {
    installations = [];
  }
  const found = process.env.CHROME_PATH ?? installations[0];
  if (found === undefined || found === '') {
    throw new Error(
      'No Chrome installation was found, so the browser workloads cannot run. Install Chrome, ' +
        'or set CHROME_PATH to an executable. This is an environment failure, not a passing run.',
    );
  }
  return found;
}

/**
 * `init` runs at document start, before the page's own scripts and before the import
 * map is parsed, which is the only place a startup measurement can be taken from. By
 * the time Node could evaluate anything, the application has already booted. It is
 * therefore plain script rather than a module, and must not import, because bare
 * specifiers do not resolve yet.
 *
 * `network` is the other thing that has to be in place before the first byte moves.
 * The harness resolves no host, so a request costs nothing to make and a serial chain
 * reads like a flat one, which is why depth rather than duration is the gated delivery
 * fact (ADR-0082). A workload that wants the round trip back asks for it here, in
 * stated conditions, and pays it on every request the page makes. ADR-0100.
 *
 * @param {Browser} browser
 * @param {string} originUrl
 * @param {string} path
 * @param {{ cache?: boolean, init?: string, network?: NetworkConditions }} options
 * @returns {Promise<BenchmarkPage>}
 */
async function openPage(browser, originUrl, path, options) {
  const page = await browser.newPage();
  const session = await page.createCDPSession();
  const traffic = await recordTraffic(session, originUrl, options.cache ?? true);

  if (options.network !== undefined) {
    await session.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: options.network.latencyMs,
      downloadThroughput: options.network.downloadBytesPerSecond,
      uploadThroughput: options.network.uploadBytesPerSecond,
    });
  }

  /** @type {string[]} */
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  if (options.init !== undefined) await page.evaluateOnNewDocument(options.init);

  /** @param {string} next @returns {Promise<void>} */
  const goto = async (next) => {
    await page.goto(`${originUrl}${next}`, { waitUntil: 'load', timeout: 60_000 });
  };

  await goto(path);

  return {
    goto,
    evaluate: (body, argument) => evaluate(session, body, argument),
    heap: () => heapUsage(session),
    retained: () => domCounters(session),
    requests: traffic.requests,
    offOrigin: traffic.offOrigin,
    reset: traffic.reset,
    errors: () => [...pageErrors],
    close: () => page.close(),
  };
}

/**
 * Run a function's source in the page and bring back its JSON result.
 *
 * A source string rather than a function reference on purpose, because workload code
 * lives in modules the page imports over the origin and what crosses this boundary is
 * a few lines that name one of them. Anything larger belongs in a module the browser
 * fetches like any other, where the checker and the linter can see it.
 *
 * @template T
 * @param {CDPSession} session
 * @param {string} body Source of a function expression: `async (arg) => { ... }`.
 * @param {unknown} argument
 * @returns {Promise<T>}
 */
async function evaluate(session, body, argument) {
  const result = await session.send('Runtime.evaluate', {
    expression: `(${body})(${JSON.stringify(argument ?? null)})`,
    awaitPromise: true,
    returnByValue: true,
  });

  if (result.exceptionDetails !== undefined) {
    const thrown = result.exceptionDetails.exception;
    const message =
      typeof thrown?.description === 'string'
        ? thrown.description
        : (result.exceptionDetails.text ?? 'unknown page-side failure');
    throw new Error(`The page threw while running a workload:\n${message}`);
  }

  // Through `unknown` in two steps, because the protocol's value is `any` and the
  // linter rightly refuses to see `any` returned as a type parameter.
  const value = /** @type {unknown} */ (result.result.value);
  return /** @type {T} */ (value);
}

/**
 * Collect garbage, then read the used JavaScript heap.
 *
 * Twice, because one collection leaves objects that only became unreachable during
 * that collection, such as a released route chain dropping listeners whose closures
 * drop scopes, and a heap read between the two attributes retained memory to the wrong
 * thing. Only the memory workloads call this, because forcing a collection inside a
 * timed loop measures the collector.
 *
 * @param {CDPSession} session
 * @returns {Promise<number>}
 */
async function heapUsage(session) {
  await session.send('HeapProfiler.collectGarbage');
  await session.send('HeapProfiler.collectGarbage');
  const usage = await session.send('Runtime.getHeapUsage');
  return usage.usedSize;
}

/**
 * @param {CDPSession} session
 * @returns {Promise<{ nodes: number, listeners: number }>}
 */
async function domCounters(session) {
  const counters = await session.send('Memory.getDOMCounters');
  return { nodes: counters.nodes, listeners: counters.jsEventListeners };
}

/**
 * Watch what the page fetches, counting requests and encoded bytes and noting anything
 * that tried to leave this origin.
 *
 * `Network.enable` rather than request interception, because interception turns the
 * cache off. Cache state comes back on the response event, so a warm load reports
 * the same request with `fromCache` set instead of vanishing from the count.
 *
 * `requestWillBeSent` carries an initiator, the parser, script or preload scanner
 * that asked for it, and dropping it is what makes a serial hop invisible. A request
 * count and a byte total are identical whether twenty transfers happen in one round
 * trip or in twenty. It is kept here and turned into a chain depth by `chain.mjs`,
 * which is the fact the delivery work is about. ADR-0082.
 *
 * @param {CDPSession} session
 * @param {string} originUrl
 * @param {boolean} cache
 * @returns {Promise<{
 *   requests: () => RequestRecord[],
 *   offOrigin: () => string[],
 *   reset: () => void,
 * }>}
 */
async function recordTraffic(session, originUrl, cache) {
  /** @type {Map<string, RequestRecord>} */
  const byRequest = new Map();
  /** @type {Set<string>} */
  const offOrigin = new Set();

  session.on('Network.requestWillBeSent', (event) => {
    if (!event.request.url.startsWith(originUrl)) {
      if (/^https?:/u.test(event.request.url)) offOrigin.add(event.request.url);
      return;
    }
    byRequest.set(event.requestId, {
      url: event.request.url.slice(originUrl.length),
      type: event.type ?? 'Other',
      status: 0,
      encodedBytes: 0,
      fromCache: false,
      // Wall clock rather than the protocol's monotonic timestamp, because the only
      // thing this is ever compared with is a mark taken inside the page, and
      // `performance.timeOrigin` puts the page's clock on this scale.
      startedAt: event.wallTime * 1000,
      initiator: initiatorOf(event.initiator, originUrl),
    });
  });

  session.on('Network.responseReceived', (event) => {
    const record = byRequest.get(event.requestId);
    if (record === undefined) return;
    record.status = event.response.status;
    record.fromCache = event.response.fromDiskCache === true;
    record.type = event.type ?? record.type;
  });

  session.on('Network.requestServedFromCache', (event) => {
    const record = byRequest.get(event.requestId);
    if (record !== undefined) record.fromCache = true;
  });

  session.on('Network.loadingFinished', (event) => {
    const record = byRequest.get(event.requestId);
    if (record !== undefined) record.encodedBytes = event.encodedDataLength;
  });

  await session.send('Network.enable');
  await session.send('Network.setCacheDisabled', { cacheDisabled: !cache });

  return {
    requests: () => [...byRequest.values()],
    offOrigin: () => [...offOrigin],
    reset: () => {
      byRequest.clear();
      offOrigin.clear();
    },
  };
}

/**
 * Which request caused this one, as a path on the measured origin.
 *
 * Three shapes reach here. The parser names the document or script it was reading.
 * A script names nothing directly and carries a stack instead, whose topmost frame
 * with a URL is the module that ran. The navigation itself names neither, and that
 * is the root of the chain rather than a missing fact.
 *
 * @param {{ type?: string, url?: string, stack?: unknown } | undefined} initiator
 * @param {string} origin
 * @returns {{ type: string, url: string | null }}
 */
function initiatorOf(initiator, origin) {
  const url = initiator?.url ?? frameUrl(initiator?.stack);
  if (url === null || !url.startsWith(origin)) return { type: initiator?.type ?? 'other', url: null };
  return { type: initiator?.type ?? 'other', url: url.slice(origin.length) };
}

/**
 * @param {unknown} stack A `Runtime.StackTrace`, whose parents are the async chain.
 * @returns {string | null}
 */
function frameUrl(stack) {
  let frames = /** @type {{ callFrames?: { url?: string }[], parent?: unknown } | undefined} */ (stack);
  while (frames !== undefined) {
    for (const frame of frames.callFrames ?? []) {
      if (typeof frame.url === 'string' && frame.url !== '') return frame.url;
    }
    frames = /** @type {typeof frames} */ (frames.parent);
  }
  return null;
}
