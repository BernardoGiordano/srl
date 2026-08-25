/**
 * The development server. Node only, zero dependencies, ~250 lines.
 *
 * Zero dependencies so that `npm start` works on a fresh clone, and not a
 * dependency of the application: any static server that can mount two directories
 * on one origin serves the same folders with no Node at all.
 *
 *   node cli/dev/serve.mjs [--app <name>] [--port 8000] [--no-watch] [--open]
 *                          [--proxy <prefix>=<origin>]...
 *
 * `--app` names a directory in the repository root: the application to serve at
 * /. Required when the repository holds more than one, and unnecessary when it
 * holds one. Everything else about the layout is fixed, because the URLs are
 * baked into each application's import map and into the deployment.
 *
 * Live reload is a full page reload rather than component hot-swapping, on
 * purpose: `customElements.define` is permanent, so a component class cannot be
 * redefined.
 *
 * `--proxy` forwards a URL prefix to a backend instead of serving it from disk,
 * which is what lets an application with an API develop on one origin — the
 * arrangement it is deployed into — rather than on two.
 */

import { createReadStream } from 'node:fs';
import { readFile, stat, watch } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { extname, join, normalize, resolve, sep } from 'node:path';

import { REPO, selectedApp } from '../layout.mjs';
import { MOUNTS as PACKAGE_MOUNTS, contentType } from '../package/interface.mjs';

/* ── Options ───────────────────────────────────────────────────────────── */

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

const { name: APP, dir: APP_DIR } = await selectedApp();
const PORT = Number(flag('port', '8000'));
const WATCH = !process.argv.includes('--no-watch');
const OPEN = process.argv.includes('--open');

/**
 * `--proxy /api/=http://127.0.0.1:8001`, repeatable: a URL prefix this server
 * forwards instead of serving from disk.
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
 * @type {Array<{ prefix: string, origin: URL }>}
 */
const PROXIES = flags('proxy').map((value) => {
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

  // Stored without its trailing slash and matched on a segment boundary below,
  // so that --proxy /api/ and --proxy /api mean the same thing and neither
  // catches /apiary.
  return { prefix: prefix.endsWith('/') ? prefix.slice(0, -1) : prefix, origin };
});

/**
 * URL prefix -> directory. The library mounts come from cli/layout.mjs, which
 * is the same table the deployment and the test runner read, so this server
 * cannot serve a layout the other two do not.
 *
 * The application is last because its mount is `/`, which matches everything.
 * A prefix that ends in `/` only matches a path segment boundary, so /libraries
 * cannot be mistaken for /lib/.
 *
 * @type {Array<[string, string]>}
 */
const MOUNTS = [...PACKAGE_MOUNTS, ['/', APP_DIR]];

/** Directories worth watching, per mount. Everything else is tooling. */
const WATCHED = MOUNTS.map(([, dir]) => dir);

/* ── Live reload ───────────────────────────────────────────────────────── */

/** Open EventSource connections, one per browser tab. */
/** @type {Set<import('node:http').ServerResponse>} */
const clients = new Set();

/**
 * Injected into the application's index.html, and only into that, when watching.
 * Keeping it out of the file on disk means the file this server sends and the
 * file nginx sends are the same bytes in production.
 */
const RELOAD_CLIENT = `
<script>
  // Development only, injected by cli/dev/serve.mjs. Not present in the file on disk.
  new EventSource('/__reload').addEventListener('message', (event) => {
    if (event.data === 'reload') location.reload();
  });
</script>
`;

/** @type {ReturnType<typeof setTimeout> | undefined} */
let reloadTimer;

/** @param {string} what */
function scheduleReload(what) {
  // Editors write a file two or three times in a few milliseconds (truncate,
  // write, rename). Debouncing turns that into one reload instead of three
  // half-loaded pages.
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    console.log('  reload  %s', what);
    for (const client of clients) client.write('data: reload\n\n');
  }, 40);
}

async function startWatching() {
  for (const target of WATCHED) {
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
        console.warn('  watch failed for %s: %s', target, String(cause));
      }
    })();
  }
}

/* ── Proxying ──────────────────────────────────────────────────────────── */

/**
 * The proxy a path belongs to, or null when it belongs to the filesystem.
 *
 * Matched on a segment boundary for the same reason the mounts are: /api must
 * not claim /apiary. First match wins, so a more specific prefix works by being
 * given first.
 *
 * @param {string} pathname
 * @returns {{ prefix: string, origin: URL } | null}
 */
function proxyFor(pathname) {
  for (const proxy of PROXIES) {
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
 * below answers 405 to anything but GET, which is correct for files and wrong
 * for an API.
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {URL} origin
 */
function forward(request, response, origin) {
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
    console.error('  502  %s  %s', request.url, String(cause));
    if (!response.headersSent) {
      response.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    }
    response.end(
      JSON.stringify({ error: 'backend_unavailable', detail: `nothing answered on ${origin.origin}` }),
    );
  });

  request.pipe(upstream);
}

/* ── Serving ───────────────────────────────────────────────────────────── */

/**
 * Resolve a URL path to a file inside one of the mounts, or null if it escapes.
 *
 * The traversal check is not theatre, and having three mounts rather than one
 * does not weaken it: the candidate is re-checked against the directory it
 * resolved into, so `GET /lib/../../.ssh/id_rsa` leaves that mount and is
 * refused rather than climbing out of the repository.
 *
 * @param {string} pathname
 * @returns {string | null}
 */
function toFilePath(pathname) {
  const decoded = decodeURIComponent(pathname);

  for (const [prefix, dir] of MOUNTS) {
    if (prefix !== '/' && !decoded.startsWith(prefix)) continue;
    const relativePath = prefix === '/' ? decoded : `/${decoded.slice(prefix.length)}`;
    const candidate = resolve(join(dir, normalize(relativePath)));
    if (candidate !== dir && !candidate.startsWith(dir + sep)) return null;
    return candidate;
  }

  return null;
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 */
async function handle(request, response) {
  const url = new URL(request.url ?? '/', `http://localhost:${String(PORT)}`);

  if (url.pathname === '/__reload') {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    response.write(': connected\n\n');
    clients.add(response);
    request.on('close', () => clients.delete(response));
    return;
  }

  // Ahead of the method check and the history fallback, both of which are rules
  // about files: a POST to /api/session must reach the backend, and a GET of a
  // path the backend owns must 404 from the backend rather than quietly return
  // index.html.
  const proxy = proxyFor(url.pathname);
  if (proxy !== null) {
    forward(request, response, proxy.origin);
    return;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }

  const filePath = toFilePath(url.pathname);
  if (filePath === null) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  let found = filePath;
  let info = await statOrNull(found);

  if (info?.isDirectory() === true) {
    found = join(found, 'index.html');
    info = await statOrNull(found);
  }

  // History fallback. Only for navigations: a missing .js must stay a 404, or a
  // typo in an import silently returns HTML and the error becomes
  // "Unexpected token '<'" from somewhere unrelated.
  if (info === null) {
    const wantsHtml = (request.headers.accept ?? '').includes('text/html');
    if (!wantsHtml || extname(url.pathname) !== '') {
      response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    found = join(APP_DIR, 'index.html');
    info = await statOrNull(found);
    if (info === null) {
      response.writeHead(404).end(`No index.html in ${APP}/`);
      return;
    }
  }

  const type = contentType(found);
  // No caching anywhere in development. A stale module served from memory cache
  // after an edit is the single most confusing failure a buildless setup has.
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-store' };

  if (WATCH && found === join(APP_DIR, 'index.html')) {
    const html = await readFile(found, 'utf8');
    const injected = html.includes('</body>')
      ? html.replace('</body>', `${RELOAD_CLIENT}</body>`)
      : html + RELOAD_CLIENT;
    const body = Buffer.from(injected, 'utf8');
    response.writeHead(200, { ...headers, 'Content-Length': String(body.byteLength) });
    response.end(request.method === 'HEAD' ? undefined : body);
    return;
  }

  response.writeHead(200, { ...headers, 'Content-Length': String(info.size) });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(found).pipe(response);
}

/**
 * @param {string} path
 * @returns {Promise<import('node:fs').Stats | null>}
 */
async function statOrNull(path) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

/* ── Start ─────────────────────────────────────────────────────────────── */

if ((await statOrNull(join(APP_DIR, 'index.html'))) === null) {
  console.error('\n  %s/index.html does not exist.', APP);
  console.error('  --app names a directory in the repository root that holds an application.\n');
  process.exit(1);
}

const server = createServer((request, response) => {
  void handle(request, response).catch((cause) => {
    console.error('  500  %s  %s', request.url, String(cause));
    if (!response.headersSent) response.writeHead(500);
    response.end('Internal error');
  });
});

server.listen(PORT, () => {
  console.log('\n  %s', `http://localhost:${String(PORT)}`);
  for (const [prefix, dir] of MOUNTS) {
    console.log('  %s -> %s', prefix.padEnd(13), dir.slice(REPO.length + 1) || '.');
  }
  for (const { prefix, origin } of PROXIES) {
    console.log('  %s -> %s', `${prefix}/`.padEnd(13), origin.origin);
  }
  console.log('  %s\n', WATCH ? 'watching for changes' : 'watch disabled');
  if (OPEN) {
    const opener =
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    void import('node:child_process').then(({ spawn }) => {
      spawn(opener, [`http://localhost:${String(PORT)}`], { stdio: 'ignore', detached: true }).unref();
    });
  }
});

if (WATCH) await startWatching();
