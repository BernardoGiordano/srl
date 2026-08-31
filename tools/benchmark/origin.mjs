/**
 * The origin under measurement: one adapter over `cli/origin/`.
 *
 * A benchmark that serves the application differently from production measures
 * the benchmark's server. So the mount table, the traversal refusal, the directory
 * index and the history fallback are the shared ones — `cli/origin/index.mjs`, the
 * same rules the development server and the artifact test origin answer with
 * (ADR-0075) — and what is stated here is only what a measurement needs
 * differently:
 *
 *   1. No live-reload injection. The bytes the browser gets here are the bytes on
 *      disk, which is what nginx sends.
 *   2. A production cache policy rather than the dev server's `no-store`:
 *      /lib/vendor immutable, everything else `no-cache`.
 *      Warm startup only means something if the second load can revalidate the
 *      way a production reload does.
 *   3. gzip, at nginx's default level, cached per file so the numbers are browser
 *      delivery rather than repeated compression work.
 *
 * One extra mount exists, at /__benchmark/, and it is why this file is not simply
 * `srl serve` with a flag: the workload modules the page imports are tooling,
 * they must not sit inside an application or the library, and they still have to
 * arrive over the same origin as the code they measure. The harness page itself is
 * generated rather than checked in, because its import map is the application's
 * own, read from that application's index.html at start-up. A copy would be a
 * fourth import map to keep in step with the other three.
 *
 * The port is ephemeral. A fixed port is a benchmark that fails when a dev server
 * is running, and there is nothing to bookmark here.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

import { readText } from '../../cli/layout.mjs';
import { send, serveOrigin } from '../../cli/origin/index.mjs';
import { MOUNTS, contentType, extractImportMap } from '../../cli/package/interface.mjs';
import { artifactDeclaration } from './declaration.mjs';

/** Browser-side workload modules, served at /__benchmark/. */
const BROWSER_DIR = resolve(fileURLToPath(new URL('./browser', import.meta.url)));

/** Where the generated harness page lives on the origin. */
export const HARNESS_PATH = '/__benchmark/harness.html';

/** nginx's configured gzip types. text/html is compressed by nginx by default. */
const GZIP_TYPES = new Set([
  'text/html; charset=utf-8',
  'text/javascript; charset=utf-8',
  'application/javascript; charset=utf-8',
  'application/json; charset=utf-8',
  'text/css; charset=utf-8',
  'image/svg+xml',
]);

/**
 * The page's Content-Security-Policy, built the way a production deployment
 * builds its own.
 *
 * Two details that are easy to get wrong and were:
 *
 *   1. An inline import map is an inline script as far as CSP is concerned, so
 *      `script-src 'self'` alone blocks it and every bare specifier then fails to
 *      resolve. The production header carries sha256 hashes for exactly this
 *      reason; this one hashes the map it just generated.
 *   2. The Trusted Types policy list is the production one, not the test runner's.
 *      The runner adds `test-harness` for its fixture strings; a benchmark does
 *      without, so no workload can reach a DOM sink by a route an application
 *      could not use.
 *
 * @param {string} importMap The exact inline script content, which is what is hashed.
 * @returns {string}
 */
function contentSecurityPolicy(importMap) {
  const hash = createHash('sha256').update(importMap, 'utf8').digest('base64');
  return (
    `default-src 'self'; script-src 'self' 'sha256-${hash}'; style-src 'self' 'unsafe-inline'; ` +
    "img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; " +
    'trusted-types lit-html ui-test ui-test-template; require-trusted-types-for \'script\''
  );
}

/**
 * @param {{ name: string, dir: string }} app
 * @param {{ artifact?: { publicDir: string, csp: string, cache: { immutable: string, revalidate: string }, assets?: readonly string[] } }} [options]
 * @returns {Promise<import('./types.js').BenchmarkOrigin>}
 */
export async function startOrigin(app, options = {}) {
  const html = await readText(join(app.dir, 'index.html'));
  const { body: importMap } = extractImportMap(html, `${app.name}/index.html`);
  const harness = Buffer.from(harnessPage(importMap), 'utf8');

  const { artifact } = options;
  const root = artifact?.publicDir ?? app.dir;
  const mounts = /** @type {Array<[string, string]>} */ (
    [...MOUNTS, ['/__benchmark/', BROWSER_DIR], ['/', root]]
  );
  const entryDocument = join(root, 'index.html');

  /** Encoded representations, keyed by file. */
  /** @type {Map<string, Buffer>} */
  const compressed = new Map();
  const applicationBackend = await createApplicationBackend(app, artifact);
  const releases = createReleaseSimulation(artifact);

  const running = await serveOrigin(
    {
      mounts,
      fallback: entryDocument,

      headers: (pathname, file) => ({
        'Cache-Control':
          artifact === undefined
            ? pathname.startsWith('/lib/vendor/')
              ? 'public, max-age=31536000, immutable'
              : 'no-cache'
            : pathname.startsWith('/assets/')
              ? artifact.cache.immutable
              : artifact.cache.revalidate,
        ...(artifact !== undefined && file === entryDocument
          ? { 'Content-Security-Policy': artifact.csp }
          : {}),
      }),

      // gzip, and nothing else: the bytes are the artifact's. Only measured
      // artifacts are compressed, because only they are what nginx would serve.
      transform: async (file, { request, stats }) => {
        if (artifact === undefined || stats.size < 512) return null;
        if (!(request.headers['accept-encoding'] ?? '').includes('gzip')) return null;
        if (!GZIP_TYPES.has(contentType(file))) return null;

        let body = compressed.get(file);
        if (body === undefined) {
          // nginx defaults to gzip level 1. Cache the encoded representation so the
          // benchmark measures browser delivery, not repeated compression work.
          body = gzipSync(await readFile(file), { level: 1 });
          compressed.set(file, body);
        }
        return { body, headers: { 'Content-Encoding': 'gzip' } };
      },

      route: async (request, response, url) => {
        if (url.pathname === HARNESS_PATH) {
          send(response, { type: 'text/html; charset=utf-8', body: harness });
          return true;
        }

        const wantsHtml = (request.headers.accept ?? '').includes('text/html');
        if (applicationBackend !== null && request.method === 'GET' && wantsHtml) {
          await applicationBackend.reset(
            url.searchParams.get('__benchmark_session') === 'authenticated',
          );
        }

        if (
          applicationBackend !== null &&
          (url.pathname.startsWith('/auth/') || url.pathname.startsWith('/api/'))
        ) {
          await applicationBackend.handle(request, response, url);
          return true;
        }

        // A static origin still needs the browser-facing half of the application's
        // backend seam, and neither adapter runs the application's server. Signed out
        // is the deterministic startup state: the real endpoint 401s, which the BFF
        // store admits as an ordinary visitor rather than a startup failure.
        //
        // Both adapters, because the alternative is not "an unauthenticated page" but
        // no page at all: the session restore is a startup step, a 404 is not a
        // refusal any store may interpret, and `startApplication` correctly turns it
        // into an ApplicationStartupError. The source origin therefore failed every
        // startup and delivery sample it took rather than measuring a slower boot.
        if (url.pathname === '/auth/session' && request.method === 'GET') {
          send(response, {
            status: 401,
            type: 'application/json; charset=utf-8',
            body: Buffer.from('{"error":"no_session"}\n'),
          });
          return true;
        }

        if (releases !== null && url.pathname.startsWith('/assets/') && !releases.admit(url.pathname)) {
          response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Asset is not retained');
          return true;
        }

        return false;
      },
    },
    {
      port: 0,
      host: '127.0.0.1',
      failed: (cause) => `Benchmark origin failed: ${String(cause)}`,
    },
  );

  return {
    url: running.url,
    ...(releases === null ? {} : { switchRelease: releases.switchRelease }),
    close: running.close,
  };
}

/**
 * The page micro-workloads run in: the application's import map, the production
 * Trusted Types policy list, and nothing else. No application module is loaded,
 * because a workload that measures template compilation should not be paying for
 * a router, a session restore and a mock backend first.
 *
 * @param {string} importMap
 * @returns {string}
 */
function harnessPage(importMap) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(importMap)}" />
    <title>benchmark harness</title>
    <script type="importmap">${importMap}</script>
  </head>
  <body></body>
</html>
`;
}

/**
 * Model only the publication fact the stale-tab workload needs: a new release no longer
 * references selected old hashes, while the shared asset store still retains them. The
 * files remain read from the verified artifact; this changes serving eligibility, never
 * artifact bytes.
 *
 * Kept inside the origin implementation: the benchmark crosses one small switch
 * interface and does not learn server routing state.
 *
 * @param {{ assets?: readonly string[] } | undefined} artifact
 */
function createReleaseSimulation(artifact) {
  if (artifact?.assets === undefined) return null;

  const all = new Set(artifact.assets);
  let current = new Set(all);
  let retained = new Set();
  /** @type {string[]} */
  let hits = [];

  return {
    /** @param {string} pathname */
    admit: (pathname) => {
      if (current.has(pathname)) return true;
      if (!retained.has(pathname)) return false;
      hits.push(pathname);
      return true;
    },
    /** @param {readonly string[]} replacedAssets */
    switchRelease: (replacedAssets) => {
      if (retained.size > 0) {
        throw new Error('The benchmark origin already has an active simulated release switch.');
      }
      for (const path of replacedAssets) {
        if (!all.has(path)) {
          throw new Error(`Cannot replace unreported artifact asset ${path}.`);
        }
      }

      retained = current;
      current = new Set([...all].filter((path) => !replacedAssets.includes(path)));
      hits = [];
      let active = true;
      return {
        retainedRequests: () => [...hits],
        restore() {
          if (!active) return;
          current = new Set(all);
          retained = new Set();
          hits = [];
          active = false;
        },
      };
    },
  };
}

/**
 * An artifact workload that walks lazy application routes needs the application's
 * backend answering behind this origin. Reuse the browser suite's HTTP fake: route
 * JavaScript still performs ordinary same-origin requests, while the benchmark avoids
 * coupling artifact delivery numbers to a database or a live account.
 *
 * The adapter is declared, not named here. An application points `backend` in its
 * benchmark.json at a module exporting `installFakeServer` — normally the very module
 * its browser suite installs, so the benchmark cannot drift from what the suite
 * asserts. An application that declares none runs against static bytes alone.
 *
 * Signing in is separate and optional: an application that wants the authenticated
 * variant exports `benchmarkSignIn(fetch, origin)` beside it. Guessing a credential
 * shape is the one thing this must not do, so a workload that asks to be signed in
 * against an application whose backend declares no sign-in fails and says which export
 * is missing.
 *
 * @param {{ name: string, dir: string }} app
 * @param {{ publicDir: string } | undefined} artifact
 */
async function createApplicationBackend(app, artifact) {
  if (artifact === undefined) return null;

  const declared = artifactDeclaration(app)?.backend;
  if (declared === undefined) return null;
  const fakeServer = join(app.dir, declared);

  const module = /** @type {{ installFakeServer: (options?: { origin?: string }) => () => void, benchmarkSignIn?: (fetch: typeof globalThis.fetch, origin: string) => Promise<void> }} */ (
    await import(pathToFileURL(fakeServer).href)
  );
  const origin = 'http://benchmark.invalid';
  /** @type {typeof fetch} */
  let fakeFetch = globalThis.fetch;

  /** @param {boolean} authenticated */
  const reset = async (authenticated) => {
    const restore = module.installFakeServer({ origin });
    fakeFetch = globalThis.fetch;
    restore();
    if (authenticated) {
      if (module.benchmarkSignIn === undefined) {
        throw new Error(
          `${app.name} asks for an authenticated benchmark but ${declared} exports no benchmarkSignIn(fetch, origin).`,
        );
      }
      await module.benchmarkSignIn(fakeFetch, origin);
    }
  };

  await reset(false);

  return {
    reset,
    /**
     * @param {import('node:http').IncomingMessage} request
     * @param {import('node:http').ServerResponse} response
     * @param {URL} url
     */
    handle: async (request, response, url) => {
      const method = request.method ?? 'GET';
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      /** @type {RequestInit} */
      const init = { method, headers };
      if (method !== 'GET' && method !== 'HEAD') init.body = await requestBody(request);

      const result = await fakeFetch(new Request(`${origin}${url.pathname}${url.search}`, init));
      const body = Buffer.from(await result.arrayBuffer());
      response.writeHead(result.status, {
        ...Object.fromEntries(result.headers),
        'Cache-Control': 'no-store',
        'Content-Length': String(body.byteLength),
      });
      response.end(body);
    },
  };
}

/** @param {import('node:http').IncomingMessage} request */
async function requestBody(request) {
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
