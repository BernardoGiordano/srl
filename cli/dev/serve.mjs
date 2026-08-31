/**
 * The development server: one adapter over `cli/origin/`, plus the two things a
 * development server has that no other origin does.
 *
 * Zero dependencies so that `npm start` works on a fresh clone, and not a
 * dependency of the application: any static server that can mount two directories
 * on one origin serves the same folders with no Node at all. The template
 * announcement below is the one thing that wants a parsed project, and it imports
 * the model lazily and declines rather than failing when it cannot: a clone with
 * no `node_modules` still gets a server, one round trip per template slower.
 *
 *   node cli/dev/serve.mjs [--app <name>] [--port 8000] [--no-watch] [--open]
 *                          [--proxy <prefix>=<origin>]...
 *
 * `--app` names a directory in the repository root: the application to serve at
 * /. Required when the repository holds more than one, and unnecessary when it
 * holds one. Everything else about the layout is fixed, because the URLs are
 * baked into each application's import map and into the deployment.
 *
 * The mounts, the traversal refusal, the directory index and the history fallback
 * are not here: they are `cli/origin/index.mjs`, which the benchmark origin and
 * the artifact test origin serve through as well. ADR-0075. What is here is the
 * part that is only true of development:
 *
 *   live reload   a full page reload rather than component hot-swapping, on
 *                 purpose: `customElements.define` is permanent, so a component
 *                 class cannot be redefined. Injected into the response and never
 *                 into the file, so the bytes this server sends and the bytes
 *                 nginx sends are the same in production.
 *   --proxy       forwards a URL prefix to a backend instead of serving it from
 *                 disk, which is what lets an application with an API develop on
 *                 one origin — the arrangement it is deployed into — rather than
 *                 on two. ADR-0069.
 *   templates     `app.manifest.json` is announced with `templateFiles`, computed
 *                 from `cli/project-model/` the way the build computes it from
 *                 what it emitted. Same manifest key, same runtime step, same
 *                 `prefetchTemplates`; the only difference between development and
 *                 production is which module wrote the list.
 *                 `cli/delivery/source-manifest.mjs`.
 *   revalidation  `no-cache` rather than the origin's `no-store` default, which
 *                 turns a reload's forty module bodies and fifty templates from
 *                 whole bodies into 304s. `cli/origin/` sends the `ETag` and
 *                 answers the `If-None-Match`; what is stated here is only that
 *                 the browser is allowed to ask. ADR-0085.
 *
 * `serveApplication` is the seam: it takes an application and its proxies and
 * returns a bound origin, so the behaviour below is assertable in-process rather
 * than by spawning this file and parsing its stdout.
 */

import { readFile, stat, watch } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { templateAnnouncer } from '../delivery/source-manifest.mjs';
import { REPO, selectedApp } from '../layout.mjs';
import { serveOrigin } from '../origin/index.mjs';
import { MOUNTS as PACKAGE_MOUNTS } from '../package/interface.mjs';

/** @import { IncomingMessage, ServerResponse } from 'node:http' */

/**
 * One backend this server forwards to instead of serving from disk.
 *
 * @typedef {{ prefix: string, origin: URL }} Proxy
 */

/** Injected into the application's index.html, and only into that, when watching. */
const RELOAD_CLIENT = `
<script>
  // Development only, injected by cli/dev/serve.mjs. Not present in the file on disk.
  new EventSource('/__reload').addEventListener('message', (event) => {
    if (event.data === 'reload') location.reload();
  });
</script>
`;

/* ── Proxying ──────────────────────────────────────────────────────────── */

/**
 * The proxy a path belongs to, or null when it belongs to the filesystem.
 *
 * Matched on a segment boundary for the same reason the mounts are: /api must
 * not claim /apiary. First match wins, so a more specific prefix works by being
 * given first.
 *
 * @param {string} pathname
 * @param {ReadonlyArray<Proxy>} proxies
 * @returns {Proxy | null}
 */
function proxyFor(pathname, proxies) {
  for (const proxy of proxies) {
    if (pathname === proxy.prefix || pathname.startsWith(`${proxy.prefix}/`)) return proxy;
  }
  return null;
}

/**
 * Forward one request upstream and stream the answer back, headers and status
 * untouched.
 *
 * Untouched is the point. Set-Cookie arrives with whatever Path, SameSite and
 * HttpOnly the backend chose, a 401 stays a 401, and a redirect is followed by
 * the browser rather than by this server — the application sees what it will see
 * through nginx. The one header rewritten is Host, which has to name the upstream
 * for a backend that routes on it.
 *
 * The request body is piped rather than buffered, so an upload is not held in
 * this process's memory, and the method is passed through: the static branch
 * answers 405 to anything but GET, which is correct for files and wrong for an
 * API.
 *
 * @param {IncomingMessage} request
 * @param {ServerResponse} response
 * @param {URL} origin
 * @param {(format: string, ...values: string[]) => void} log
 */
function forward(request, response, origin, log) {
  const send = origin.protocol === 'https:' ? httpsRequest : httpRequest;

  const upstream = send(
    {
      protocol: origin.protocol,
      hostname: origin.hostname,
      port: origin.port,
      path: request.url,
      method: request.method,
      headers: { ...request.headers, host: origin.host },
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );

  // A backend that is not running is the ordinary case — it is a separate process
  // a developer starts separately — so it reads as one line naming the origin
  // nothing answered on, not a stack trace.
  upstream.on('error', (cause) => {
    log('  502  %s  %s', request.url ?? '/', String(cause));
    if (!response.headersSent) {
      response.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    }
    response.end(
      JSON.stringify({
        error: 'backend_unavailable',
        detail: `nothing answered on ${origin.origin}`,
      }),
    );
  });

  request.pipe(upstream);
}

/* ── The server ────────────────────────────────────────────────────────── */

/**
 * Serve one application, with live reload and any number of backends behind it.
 *
 * @param {object} options
 * @param {{ name: string, dir: string }} options.app
 * @param {number} [options.port] 0 for an ephemeral one, which is what a test wants.
 * @param {string | null} [options.host] Null, the default here, binds every interface.
 * @param {boolean} [options.watch] Watch the mounts and reload the page.
 * @param {ReadonlyArray<Proxy>} [options.proxies]
 * @param {(format: string, ...values: string[]) => void} [options.log]
 * @returns {Promise<{ url: string, port: number, mounts: Array<[string, string]>, close: () => Promise<void> }>}
 */
export async function serveApplication(options) {
  const { app } = options;
  const watching = options.watch ?? true;
  const proxies = options.proxies ?? [];
  const log = options.log ?? (() => undefined);

  /**
   * URL prefix -> directory. The library mounts come from the package, which is
   * the same table the deployment and the test runner read, so this server cannot
   * serve a layout the other two do not.
   *
   * The application is last because its mount is `/`, which matches everything.
   *
   * @type {Array<[string, string]>}
   */
  const mounts = [...PACKAGE_MOUNTS, ['/', app.dir]];
  const entryDocument = join(app.dir, 'index.html');
  const manifest = templateAnnouncer(app, log);

  /** Open EventSource connections, one per browser tab. */
  /** @type {Set<ServerResponse>} */
  const clients = new Set();

  const running = await serveOrigin(
    {
      mounts,
      fallback: entryDocument,

      /**
       * Revalidation rather than the origin's `no-store`.
       *
       * `no-store` is the safe default for an origin that knows nothing about its
       * caller, and it is the wrong one here: it deletes the browser cache, so the
       * second reload costs exactly what the first did — every module and every
       * template as a whole body. `no-cache` keeps the entry and requires the
       * browser to revalidate it before use, which is a 304 for everything the
       * developer did not touch and a 200 for the file they did.
       *
       * The stale-module failure `no-store` was guarding against needs the
       * validator to lie, and it is built from size and mtime: an edit changes at
       * least one of them. A checkout that restores an old mtime at an identical
       * size is the residue, and it is a `touch` away — which is a trade worth
       * making for the two thirds of a reload this returns.
       */
      headers: () => ({ 'Cache-Control': 'no-cache' }),

      /**
       * Two documents are not the file on disk: the entry, which carries the
       * reload client while watching, and the manifest, which carries the template
       * list the build would have written. Every other byte is streamed.
       */
      transform: async (file) => {
        if (file === manifest.file) return manifest.representation();
        if (!watching || file !== entryDocument) return null;
        const html = await readFile(file, 'utf8');
        const injected = html.includes('</body>')
          ? html.replace('</body>', `${RELOAD_CLIENT}</body>`)
          : html + RELOAD_CLIENT;
        return { body: Buffer.from(injected, 'utf8') };
      },

      route: (request, response, url) => {
        if (url.pathname === '/__reload') {
          response.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
          });
          response.write(': connected\n\n');
          clients.add(response);
          request.on('close', () => clients.delete(response));
          return true;
        }

        // Ahead of the method check and the history fallback, both of which are
        // rules about files: a POST to /api/session must reach the backend, and a
        // GET of a path the backend owns must 404 from the backend rather than
        // quietly return index.html.
        const proxy = proxyFor(url.pathname, proxies);
        if (proxy === null) return false;
        forward(request, response, proxy.origin, log);
        return true;
      },
    },
    {
      port: options.port ?? 8000,
      host: options.host ?? null,
      failed: (cause, request) => {
        log('  500  %s  %s', request.url ?? '/', String(cause));
      },
    },
  );

  if (watching) {
    await startWatching(mounts, log, clients);
    // On the same signal as the watcher, and for the same reason: watching means a
    // human is about to load this page, and the model's first build is ~200 ms of
    // importing a compiler. A suite that asks for a server without one is asking
    // for a server, not for a warm cache.
    manifest.warm();
  }

  return { url: running.url, port: running.port, mounts, close: running.close };
}

/* ── Live reload ───────────────────────────────────────────────────────── */

/**
 * Watch every mount and reload the page when one of them changes.
 *
 * @param {ReadonlyArray<readonly [string, string]>} mounts
 * @param {(format: string, ...values: string[]) => void} log
 * @param {Set<ServerResponse>} clients
 */
async function startWatching(mounts, log, clients) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let reloadTimer;

  /** @param {string} what */
  const scheduleReload = (what) => {
    // Editors write a file two or three times in a few milliseconds (truncate,
    // write, rename). Debouncing turns that into one reload instead of three
    // half-loaded pages.
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      log('  reload  %s', what);
      for (const client of clients) client.write('data: reload\n\n');
    }, 40);
  };

  for (const [, target] of mounts) {
    try {
      await stat(target);
    } catch {
      continue;
    }

    void (async () => {
      try {
        for await (const event of watch(target, { recursive: true })) {
          if (event.filename === null) continue;
          if (event.filename.endsWith('~') || event.filename.startsWith('.')) continue;
          // vendor/ changes are a `npm run vendor` away, never an edit.
          if (event.filename.split(sep)[0] === 'vendor') continue;
          scheduleReload(join(target.slice(REPO.length + 1), event.filename));
        }
      } catch (cause) {
        log('  watch failed for %s: %s', target, String(cause));
      }
    })();
  }
}

/* ── As a command ──────────────────────────────────────────────────────────
 *
 * Guarded, so importing `serveApplication` above costs no argument parsing, no
 * port and no exit codes.
 */

/**
 * @param {string} name
 * @param {string | undefined} fallback
 * @returns {string | undefined}
 */
function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

/**
 * Every value given for a repeatable flag, in the order given. `--proxy` is the
 * only one: an application can have more than one backend, and the alternative —
 * one flag holding a comma-separated list — puts a second parser in a string
 * whose contents are already URLs.
 *
 * @param {string} name
 * @returns {string[]}
 */
function flags(name) {
  /** @type {string[]} */
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== `--${name}`) continue;
    const value = process.argv[index + 1];
    if (value !== undefined && !value.startsWith('--')) values.push(value);
  }
  return values;
}

/**
 * `--proxy /api/=http://127.0.0.1:8001`, repeatable.
 *
 * An application with a backend needs it on this origin rather than a second one.
 * A session cookie is returned only to the origin that set it, so a dev server
 * that cannot forward /api/ leaves two options, and both have the application
 * developed against an arrangement it does not ship: a CORS and third-party-cookie
 * dance that production never performs, or a hand-written server beside this one
 * that re-implements the mounts in order to add ten lines of proxy.
 *
 * Routes only, no rewriting. In production the same prefixes are a location block
 * in nginx, and a flag that could rewrite paths would be a second routing table to
 * keep in step with that one.
 *
 * Refused at startup rather than at the first request: a typo in an origin is a
 * startup error, not a 502 half an hour later.
 *
 * @returns {Proxy[]}
 */
function proxiesFromArgv() {
  return flags('proxy').map((value) => {
    const separator = value.indexOf('=');
    if (separator === -1) {
      console.error('\n  --proxy %s is not <prefix>=<origin>.', value);
      console.error('  For example: --proxy /api/=http://127.0.0.1:8001\n');
      process.exit(1);
    }

    const prefix = value.slice(0, separator);
    const target = value.slice(separator + 1);

    if (!prefix.startsWith('/')) {
      console.error('\n  --proxy prefix %s does not start with "/".\n', prefix);
      process.exit(1);
    }

    let origin;
    try {
      origin = new URL(target);
    } catch {
      console.error('\n  --proxy origin %s is not a URL.', target);
      console.error('  For example: --proxy %s=http://127.0.0.1:8001\n', prefix);
      process.exit(1);
    }

    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') {
      console.error('\n  --proxy origin %s is not http or https.\n', target);
      process.exit(1);
    }

    // Stored without its trailing slash and matched on a segment boundary, so that
    // --proxy /api/ and --proxy /api mean the same thing and neither catches
    // /apiary.
    return { prefix: prefix.endsWith('/') ? prefix.slice(0, -1) : prefix, origin };
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await selectedApp();
  const port = Number(flag('port', '8000'));
  const watching = !process.argv.includes('--no-watch');
  const proxies = proxiesFromArgv();

  try {
    await stat(join(app.dir, 'index.html'));
  } catch {
    console.error('\n  %s/index.html does not exist.', app.name);
    console.error('  --app names a directory in the repository root that holds an application.\n');
    process.exit(1);
  }

  const server = await serveApplication({
    app,
    port,
    watch: watching,
    proxies,
    log: (format, ...values) => {
      console.log(format, ...values);
    },
  });

  console.log('\n  %s', `http://localhost:${String(server.port)}`);
  for (const [prefix, dir] of server.mounts) {
    console.log('  %s -> %s', prefix.padEnd(13), dir.slice(REPO.length + 1) || '.');
  }
  for (const { prefix, origin } of proxies) {
    console.log('  %s -> %s', `${prefix}/`.padEnd(13), origin.origin);
  }
  console.log('  %s\n', watching ? 'watching for changes' : 'watch disabled');

  if (process.argv.includes('--open')) {
    const opener =
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    void import('node:child_process').then(({ spawn }) => {
      spawn(opener, [`http://localhost:${String(server.port)}`], {
        stdio: 'ignore',
        detached: true,
      }).unref();
    });
  }
}
