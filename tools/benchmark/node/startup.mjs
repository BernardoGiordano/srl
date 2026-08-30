/**
 * Startup and delivery workloads: what it costs to open the application.
 *
 * WHY THESE ARE DRIVEN FROM NODE
 *
 * A startup measurement cannot be taken from inside a page that has already
 * started. By the time Node could evaluate anything, the import map has been
 * parsed, the root module has run and the first route has settled — so the
 * stopwatch is installed at document start instead, before the page's own scripts,
 * and Node only reads what it recorded.
 *
 * WHAT "FIRST ROUTE SETTLEMENT" MEANS HERE
 *
 * The first element inside the shell's outlet. Observed through a MutationObserver
 * rather than by importing the router, for two reasons: at document start no bare
 * specifier resolves yet, and an application's first view appearing is the fact a
 * user experiences. It is the same moment `navigationSettled()` resolves for the
 * entry navigation, arrived at without needing the router's cooperation.
 *
 * REQUESTS AND BYTES
 *
 * The same load answers the delivery questions, so they are one workload rather
 * than two loads measuring the same page: how many native module requests an entry
 * route costs, how many encoded bytes arrive, and how much of that is the
 * development Tailwind that production replaces with a compiled stylesheet.
 *
 * AND HOW MANY OF THEM WAITED FOR EACH OTHER
 *
 * `chainDepth` is the third delivery fact, and the only one of the three that moves
 * when a transfer stops being discovered and starts being announced. The harness
 * resolves no host, so no request pays a real round trip and neither a count nor a
 * byte total can tell a flat graph from a serial one. `../chain.mjs` derives it from
 * the initiator each request already carries. ADR-0082.
 */

import { join } from 'node:path';

import { apps, readText } from '../../../cli/layout.mjs';
import { requestChain, until } from '../chain.mjs';
import { artifactDeclaration } from '../declaration.mjs';

/** @import { ArtifactDeclaration, BenchmarkPage, BenchmarkSample, NodeWorkloadContext, WorkloadSpec } from '../types.js' */

/** How long a load may take before the sample is called a failure. */
const LOAD_TIMEOUT_MS = 30_000;

/**
 * Every application's artifact declaration, read once because the workload list is a
 * static export. An application that ships no benchmark.json contributes nothing here.
 *
 * @type {ArtifactDeclaration[]}
 */
const ARTIFACT_DECLARATIONS = (await apps())
  .map((app) => artifactDeclaration(app))
  .filter((declaration) => declaration !== null);

/**
 * The application's root custom element, read from its own index.html.
 *
 * Derived rather than configured: the root tag is already stated in the page the
 * browser loads, and a benchmark that repeated it would be the fifth place that
 * fact lives.
 *
 * @param {string} appDir
 * @returns {Promise<string>}
 */
async function rootTagOf(appDir) {
  const html = await readText(join(appDir, 'index.html'));
  const body = html.slice(html.indexOf('<body'));
  const match = /<([a-z][a-z0-9]*-[a-z0-9-]*)\b/u.exec(body);
  if (match?.[1] === undefined) {
    throw new Error(`No custom element found in the body of ${appDir}/index.html.`);
  }
  return match[1];
}

/**
 * The stopwatch, installed at document start. Plain script: no imports, because the
 * import map does not exist yet.
 *
 * @param {string} rootTag
 * @returns {string}
 */
function initScript(rootTag) {
  return `(() => {
    const marks = { rootDefined: null, firstView: null };
    window.__bench = marks;
    customElements.whenDefined(${JSON.stringify(rootTag)}).then(() => {
      marks.rootDefined = performance.now();
    });
    const check = () => {
      const outlet = document.querySelector('main');
      if (outlet !== null && outlet.firstElementChild !== null) {
        marks.firstView = performance.now();
        observer.disconnect();
        return true;
      }
      return false;
    };
    const observer = new MutationObserver(() => void check());
    observer.observe(document, { subtree: true, childList: true });
  })()`;
}

/**
 * Read the marks back once the first view is on screen.
 *
 * The wait is in the page rather than in Node so that the recorded time is the
 * page's own clock and owes nothing to protocol latency.
 */
const READ_MARKS = `async (timeout) => {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (window.__bench?.firstView !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const navigation = performance.getEntriesByType('navigation')[0];
  return {
    rootDefined: window.__bench?.rootDefined ?? null,
    firstView: window.__bench?.firstView ?? null,
    load: navigation?.loadEventEnd ?? null,
    domContentLoaded: navigation?.domContentLoadedEventEnd ?? null,
    // What puts the page's clock and the protocol's request times on one scale, so
    // the chain can end where the first view appeared rather than where the harness
    // stopped reading.
    timeOrigin: performance.timeOrigin,
  };
}`;

/**
 * One application load, cold or warm, reported as one sample.
 *
 * @param {NodeWorkloadContext} context
 * @param {{ warm: boolean, delivery?: boolean }} options
 * @returns {Promise<BenchmarkSample>}
 */
async function loadSample(context, options) {
  const rootTag = await rootTagOf(context.app.dir);
  const page = await context.browser.load('/', {
    cache: options.warm,
    init: initScript(rootTag),
  });

  try {
    if (options.warm) {
      // The first load only fills the cache. Everything reported comes from the
      // second, which is what a reload of a deployed application does.
      await page.evaluate(READ_MARKS, LOAD_TIMEOUT_MS);
      page.reset();
      await page.goto('/');
    }

    const marks = /** @type {{ rootDefined: number | null, firstView: number | null, load: number | null, domContentLoaded: number | null, timeOrigin: number }} */ (
      await page.evaluate(READ_MARKS, LOAD_TIMEOUT_MS)
    );

    const offOrigin = page.offOrigin();
    const errors = page.errors();
    const requests = page.requests();

    if (offOrigin.length > 0) {
      return { ok: false, detail: `the page requested off-origin URLs: ${offOrigin.join(', ')}` };
    }
    if (errors.length > 0) {
      return { ok: false, detail: `the page reported errors: ${errors.join(' | ')}` };
    }
    if (marks.firstView === null) {
      return { ok: false, detail: 'no routed view appeared inside the shell outlet.' };
    }

    const modules = requests.filter((request) => request.url.endsWith('.js'));
    const templates = requests.filter(
      (request) => request.url.endsWith('.html') || request.url.includes('/assets/template'),
    );
    // The chain ends at the first routed view. Requests a mounted view starts for its
    // own data are a later question, and counting them would make the depth depend on
    // how long the harness happened to keep reading.
    const chain = requestChain(until(requests, marks.timeOrigin + marks.firstView));
    const encodedBytes = requests.reduce((total, request) => total + request.encodedBytes, 0);
    const tailwind = requests
      .filter((request) => request.url.includes('tailwind'))
      .reduce((total, request) => total + request.encodedBytes, 0);
    const cached = requests.filter((request) => request.fromCache).length;

    /** @type {Record<string, number>} */
    const metrics = options.delivery === true
      ? {
          requests: requests.length,
          chainDepth: chain.depth,
          moduleRequests: modules.length,
          templateRequests: templates.length,
          encodedBytes,
          moduleBytes: modules.reduce((total, request) => total + request.encodedBytes, 0),
          templateBytes: templates.reduce((total, request) => total + request.encodedBytes, 0),
          tailwindBytes: tailwind,
          appCssBytes: requests
            .filter((request) => request.url.endsWith('.css'))
            .reduce((total, request) => total + request.encodedBytes, 0),
        }
      : {
          firstView: marks.firstView,
          rootDefined: marks.rootDefined ?? marks.firstView,
          load: marks.load ?? marks.firstView,
          requests: requests.length,
          chainDepth: chain.depth,
          fromCache: cached,
        };

    return { ok: true, duration: marks.firstView, metrics };
  } finally {
    await page.close();
  }
}

/**
 * @param {NodeWorkloadContext} context
 * @param {{ warm: boolean, delivery?: boolean }} options
 * @returns {Promise<BenchmarkSample[]>}
 */
async function repeatLoad(context, options) {
  /** @type {BenchmarkSample[]} */
  const samples = [];
  for (let index = 0; index < context.warmup + context.samples; index += 1) {
    const sample = await loadSample(context, options);
    if (index >= context.warmup || !sample.ok) samples.push(sample);
    if (!sample.ok) break;
  }
  return samples;
}

/**
 * Wait for the authenticated fake session to settle on the eager login route.
 * Starting there leaves every application route chunk cold for the measured
 * navigation while still running the real session restore and route guard.
 */
const WAIT_FOR_LOGIN = `async (timeout) => {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (location.pathname === '/login' && document.querySelector('login-page') !== null) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}`;

/** Navigate one real application route and time first appearance of its page. */
const NAVIGATE_ROUTE = `async (input) => {
  const previous = [...document.querySelectorAll('x-route-outlet')]
    .at(-1)?.firstElementChild;
  previous?.setAttribute('data-benchmark-previous', '');
  const started = performance.now();
  history.pushState(null, '', input.path);
  dispatchEvent(new PopStateEvent('popstate'));
  const deadline = started + input.timeout;
  let element = null;
  while (performance.now() < deadline) {
    element = document.querySelector(input.tag + ':not([data-benchmark-previous])');
    if (location.pathname === input.path && element !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const duration = performance.now() - started;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return {
    duration,
    rendered: element !== null,
    path: location.pathname,
  };
}`;

/** Navigate the full route set after its immutable assets were primed in another page. */
const NAVIGATE_ROUTE_TOUR = `async (input) => {
  const durations = [];
  const started = performance.now();
  for (const route of input.routes) {
    const previous = [...document.querySelectorAll('x-route-outlet')]
      .at(-1)?.firstElementChild;
    previous?.setAttribute('data-benchmark-previous', '');
    const routeStarted = performance.now();
    history.pushState(null, '', route.path);
    dispatchEvent(new PopStateEvent('popstate'));
    const deadline = routeStarted + input.timeout;
    let element = null;
    while (performance.now() < deadline) {
      element = document.querySelector(route.tag + ':not([data-benchmark-previous])');
      if (location.pathname === route.path && element !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (element === null || location.pathname !== route.path) {
      return { ok: false, path: route.path, tag: route.tag };
    }
    durations.push(performance.now() - routeStarted);
  }
  const total = performance.now() - started;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  durations.sort((left, right) => left - right);
  const rank = (fraction) => durations[Math.max(0, Math.ceil(durations.length * fraction) - 1)] ?? 0;
  return {
    ok: true,
    duration: total,
    routeMedian: rank(0.5),
    routeP95: rank(0.95),
  };
}`;

/**
 * @param {NodeWorkloadContext} context
 * @param {boolean} cache
 */
async function openAuthenticatedApplication(context, cache) {
  const page = await context.browser.load('/login?__benchmark_session=authenticated', { cache });
  const ready = await page.evaluate(WAIT_FOR_LOGIN, LOAD_TIMEOUT_MS);
  if (ready !== true) {
    await page.close();
    throw new Error('authenticated Space benchmark did not settle on the login route.');
  }
  return page;
}

/**
 * @param {BenchmarkPage} page
 * @param {{ duration: number, rendered?: boolean, path?: string, ok?: boolean }} result
 * @param {string} expectedPath
 * @returns {BenchmarkSample}
 */
function routeSample(page, result, expectedPath) {
  const offOrigin = page.offOrigin();
  const errors = page.errors();
  const requests = page.requests();
  const failed = requests.filter((request) => request.status >= 400);
  if (offOrigin.length > 0) {
    return { ok: false, detail: `the page requested off-origin URLs: ${offOrigin.join(', ')}` };
  }
  if (errors.length > 0) {
    return { ok: false, detail: `the page reported errors: ${errors.join(' | ')}` };
  }
  if (failed.length > 0) {
    return {
      ok: false,
      detail: `route requests failed: ${failed.map((request) => `${request.url} ${String(request.status)}`).join(', ')}`,
    };
  }
  if (
    result.rendered === false ||
    result.ok === false ||
    (result.path !== undefined && result.path !== expectedPath)
  ) {
    return { ok: false, detail: `route ${expectedPath} did not render at its requested path.` };
  }

  const modules = requests.filter((request) => request.url.endsWith('.js'));
  const templates = requests.filter(
    (request) => request.url.endsWith('.html') || request.url.includes('/assets/template'),
  );
  // Every request here belongs to the navigation: the recorder was reset immediately
  // before it, so the whole set is the chain that navigation walked.
  const chain = requestChain(requests);
  return {
    ok: true,
    duration: result.duration,
    metrics: {
      requests: requests.length,
      chainDepth: chain.depth,
      moduleRequests: modules.length,
      templateRequests: templates.length,
      encodedBytes: requests.reduce((total, request) => total + request.encodedBytes, 0),
      moduleBytes: modules.reduce((total, request) => total + request.encodedBytes, 0),
      fromCache: requests.filter((request) => request.fromCache).length,
    },
  };
}

/**
 * @param {NodeWorkloadContext} context
 * @param {{ id: string, path: string, tag: string }} route
 */
async function repeatLazyRoute(context, route) {
  /** @type {BenchmarkSample[]} */
  const samples = [];
  for (let index = 0; index < context.warmup + context.samples; index += 1) {
    const page = await openAuthenticatedApplication(context, false);
    try {
      page.reset();
      const result = /** @type {{ duration: number, rendered: boolean, path: string }} */ (
        await page.evaluate(NAVIGATE_ROUTE, { ...route, timeout: LOAD_TIMEOUT_MS })
      );
      const sample = routeSample(page, result, route.path);
      if (index >= context.warmup || !sample.ok) samples.push(sample);
      if (!sample.ok) break;
    } finally {
      await page.close();
    }
  }
  return samples;
}

/**
 * @param {NodeWorkloadContext} context
 * @param {ReadonlyArray<{ id: string, path: string, tag: string }>} lazyRoutes
 */
async function repeatCachedRouteTour(context, lazyRoutes) {
  /** @type {BenchmarkSample[]} */
  const samples = [];
  for (let index = 0; index < context.warmup + context.samples; index += 1) {
    const primer = await openAuthenticatedApplication(context, true);
    try {
      const primed = /** @type {{ ok: boolean }} */ (
        await primer.evaluate(NAVIGATE_ROUTE_TOUR, {
          routes: lazyRoutes,
          timeout: LOAD_TIMEOUT_MS,
        })
      );
      if (!primed.ok) throw new Error('Space route cache primer did not render every lazy route.');
    } finally {
      await primer.close();
    }

    const page = await openAuthenticatedApplication(context, true);
    try {
      page.reset();
      const result = /** @type {{ ok: boolean, duration: number, routeMedian: number, routeP95: number, path?: string }} */ (
        await page.evaluate(NAVIGATE_ROUTE_TOUR, {
          routes: lazyRoutes,
          timeout: LOAD_TIMEOUT_MS,
        })
      );
      const sample = routeSample(page, result, lazyRoutes.at(-1)?.path ?? '');
      if (sample.ok && sample.metrics !== undefined) {
        sample.metrics.routes = lazyRoutes.length;
        sample.metrics.routeMedian = result.routeMedian;
        sample.metrics.routeP95 = result.routeP95;
      }
      if (index >= context.warmup || !sample.ok) samples.push(sample);
      if (!sample.ok) break;
    } finally {
      await page.close();
    }
  }
  return samples;
}

/**
 * Keep one authenticated page on the old release, move its unopened route chunk out of
 * the simulated current release, then navigate. Success requires the origin to serve
 * that exact hash from retained assets; sharing a filename with the new release cannot
 * accidentally make this pass.
 *
 * @param {NodeWorkloadContext} context
 * @param {{ path: string, tag: string, module: string }} staleRoute
 */
async function repeatStaleReleaseNavigation(context, staleRoute) {
  const switchRelease = context.origin.switchRelease;
  if (switchRelease === undefined) {
    throw new Error('stale-release workload requires a switchable dist origin.');
  }
  const chunk = context.artifact?.report.chunks.find(
    (candidate) =>
      candidate.dynamicEntry && candidate.modules.includes(staleRoute.module),
  );
  if (chunk === undefined) {
    throw new Error(`artifact report does not identify ${staleRoute.module}.`);
  }
  const asset = `/${chunk.path}`;

  /** @type {BenchmarkSample[]} */
  const samples = [];
  for (let index = 0; index < context.warmup + context.samples; index += 1) {
    const page = await openAuthenticatedApplication(context, false);
    const release = switchRelease([asset]);
    try {
      page.reset();
      const result = /** @type {{ duration: number, rendered: boolean, path: string }} */ (
        await page.evaluate(NAVIGATE_ROUTE, {
          ...staleRoute,
          timeout: LOAD_TIMEOUT_MS,
        })
      );
      const sample = routeSample(page, result, staleRoute.path);
      const retained = release.retainedRequests();
      if (sample.ok && !retained.includes(asset)) {
        samples.push({
          ok: false,
          detail: `${asset} rendered without crossing the retained-release asset store.`,
        });
        break;
      }
      if (sample.ok && sample.metrics !== undefined) {
        sample.metrics.releaseSwitches = 1;
        sample.metrics.retainedAssetRequests = retained.length;
      }
      if (index >= context.warmup || !sample.ok) samples.push(sample);
      if (!sample.ok) break;
    } finally {
      release.restore();
      await page.close();
    }
  }
  return samples;
}

/**
 * Record deterministic artifact bytes beside browser delivery measurements. This reads
 * the already-verified report supplied by the dist origin adapter; it never rebuilds or
 * scans source, so the baseline follows exactly the bytes eligible for publication.
 *
 * @param {NodeWorkloadContext} context
 * @returns {Promise<BenchmarkSample[]>}
 */
function artifactSize(context) {
  const report = context.artifact?.report;
  if (report === undefined) {
    return Promise.resolve([
      { ok: false, detail: 'artifact size workload requires the dist origin adapter.' },
    ]);
  }

  const files = report.files;
  /**
   * @param {(path: string) => boolean} match
   * @param {'bytes' | 'gzip'} field
   */
  const sum = (match, field) =>
    files
      .filter((file) => match(file.path))
      .reduce((total, file) => total + file[field], 0);
  /** @param {string} path */
  const javascript = (path) => path.endsWith('.js');
  /** @param {string} path */
  const css = (path) => path.endsWith('.css');
  /** @param {string} path */
  const templates = (path) =>
    path.includes('/assets/templates') && (path.endsWith('.json') || path.endsWith('.html'));

  return Promise.resolve([
    {
      ok: true,
      metrics: {
        files: report.totals.files,
        // The build's own derivation, not a second one: `chain` is admitted by
        // `parseReport` against `chunks[].imports` before it reaches disk, so the
        // gate below is on a number no browser had to be started to produce.
        chainDepth: report.chain.depth,
        rawBytes: report.totals.bytes,
        gzipBytes: report.totals.gzip,
        brotliBytes: report.totals.brotli,
        javascriptRawBytes: sum(javascript, 'bytes'),
        javascriptGzipBytes: sum(javascript, 'gzip'),
        cssRawBytes: sum(css, 'bytes'),
        cssGzipBytes: sum(css, 'gzip'),
        templateRawBytes: sum(templates, 'bytes'),
        templateGzipBytes: sum(templates, 'gzip'),
      },
    },
  ]);
}

const LAZY_ROUTE_UNITS = {
  duration: 'ms',
  requests: 'count',
  chainDepth: 'depth',
  moduleRequests: 'count',
  templateRequests: 'count',
  encodedBytes: 'bytes',
  moduleBytes: 'bytes',
  fromCache: 'count',
};

/**
 * The delivery workloads one declaration produces. Exported so a suite can build them
 * from a fixture declaration rather than needing a real application to exist.
 *
 * @param {ArtifactDeclaration} declaration
 * @returns {WorkloadSpec[]}
 */
export function artifactWorkloads(declaration) {
  const apps = [declaration.app];
  const origins = [/** @type {'dist'} */ ('dist')];

  /** @type {WorkloadSpec[]} */
  const workloads = [
    {
      id: 'delivery/artifact-size',
      suite: 'delivery',
      title: 'Verified production artifact size',
      driver: 'node',
      samples: { local: 1, ci: 1 },
      warmup: { local: 0, ci: 0 },
      apps,
      origins,
      units: {
        files: 'count',
        chainDepth: 'depth',
        rawBytes: 'artifact-bytes',
        gzipBytes: 'artifact-bytes',
        brotliBytes: 'artifact-bytes',
        javascriptRawBytes: 'artifact-bytes',
        javascriptGzipBytes: 'artifact-bytes',
        cssRawBytes: 'artifact-bytes',
        cssGzipBytes: 'artifact-bytes',
        templateRawBytes: 'artifact-bytes',
        templateGzipBytes: 'artifact-bytes',
      },
      run: artifactSize,
    },
    ...declaration.lazyRoutes.map((route) => ({
      id: `delivery/lazy-${route.id}`,
      suite: /** @type {'delivery'} */ ('delivery'),
      title: `First authenticated navigation to ${route.path}`,
      driver: /** @type {'node'} */ ('node'),
      samples: { local: 5, ci: 3 },
      warmup: { local: 1, ci: 1 },
      apps,
      origins,
      units: LAZY_ROUTE_UNITS,
      run: (/** @type {NodeWorkloadContext} */ context) => repeatLazyRoute(context, route),
    })),
    {
      id: 'delivery/lazy-routes-cached',
      suite: 'delivery',
      title: 'Every lazy route after immutable browser-cache priming',
      driver: 'node',
      samples: { local: 3, ci: 2 },
      warmup: { local: 1, ci: 1 },
      apps,
      origins,
      units: { ...LAZY_ROUTE_UNITS, routes: 'count', routeMedian: 'ms', routeP95: 'ms' },
      run: (context) => repeatCachedRouteTour(context, declaration.lazyRoutes),
    },
  ];

  const stale = declaration.staleReleaseRoute;
  if (stale !== undefined) {
    workloads.push({
      id: 'delivery/lazy-stale-release',
      suite: 'delivery',
      title: 'Old tab opens an uncached lazy route after a release switch',
      driver: 'node',
      samples: { local: 3, ci: 2 },
      warmup: { local: 1, ci: 1 },
      apps,
      origins,
      units: { ...LAZY_ROUTE_UNITS, releaseSwitches: 'count', retainedAssetRequests: 'count' },
      run: (context) => repeatStaleReleaseNavigation(context, stale),
    });
  }

  return workloads;
}

const ARTIFACT_WORKLOADS = ARTIFACT_DECLARATIONS.flatMap(artifactWorkloads);

/** @type {WorkloadSpec[]} */
export const STARTUP_WORKLOADS = [
  {
    id: 'startup/cold',
    suite: 'startup',
    title: 'Cold application start, empty cache, to first routed view',
    driver: 'node',
    samples: { local: 5, ci: 3 },
    warmup: { local: 1, ci: 1 },
    units: {
      duration: 'ms',
      firstView: 'ms',
      rootDefined: 'ms',
      load: 'ms',
      requests: 'count',
      chainDepth: 'depth',
      fromCache: 'count',
    },
    run: (context) => repeatLoad(context, { warm: false }),
  },
  {
    id: 'startup/warm',
    suite: 'startup',
    title: 'Warm application start, primed cache, to first routed view',
    driver: 'node',
    samples: { local: 5, ci: 3 },
    warmup: { local: 1, ci: 1 },
    units: {
      duration: 'ms',
      firstView: 'ms',
      rootDefined: 'ms',
      load: 'ms',
      requests: 'count',
      chainDepth: 'depth',
      fromCache: 'count',
    },
    run: (context) => repeatLoad(context, { warm: true }),
  },
  {
    id: 'delivery/entry-route',
    suite: 'delivery',
    title: 'Native module requests and encoded bytes for the entry route',
    driver: 'node',
    /**
     * Warmed and sampled like `startup/cold`, which loads the same page, because it
     * had neither and its duration was a coin flip: two samples with no warmup put
     * whatever the browser had not done yet into half the median, and the same
     * unchanged repository reported 86.5 ms and 103.8 ms in consecutive gated runs
     * while `startup/cold` — three samples, one warmup — stayed within 2% of its
     * baseline in both. The counts and the byte totals were never affected; they are
     * identical in every run. A warmup sample cannot help the measurement either,
     * because `warm: false` gives each sample its own empty cache.
     */
    samples: { local: 5, ci: 3 },
    warmup: { local: 1, ci: 1 },
    units: {
      duration: 'ms',
      requests: 'count',
      chainDepth: 'depth',
      moduleRequests: 'count',
      templateRequests: 'count',
      encodedBytes: 'bytes',
      moduleBytes: 'bytes',
      templateBytes: 'bytes',
      tailwindBytes: 'bytes',
      appCssBytes: 'bytes',
    },
    run: (context) => repeatLoad(context, { warm: false, delivery: true }),
  },
  ...ARTIFACT_WORKLOADS,
];
