/**
 * The example application's server.
 *
 *   node example/server/server.mjs [--port 8100] [--open] [--api-only]
 *
 * Plain Node, zero dependencies, no database, no `npm install`. It serves the
 * application, the framework and the shared collection on one origin, and answers
 * `/auth/*` and `/api/*` itself.
 *
 * `--api-only` drops the static half, for the deployment where nginx already
 * serves the files and this process sits behind it on /auth and /api. It is not
 * only an optimisation: static.mjs reads the mount table from tools/layout.mjs,
 * and tools/ is a development directory the released tree deliberately omits,
 * so importing it on the server is a startup crash. Hence the dynamic import
 * below rather than a flag checked inside serveStatic.
 *
 * Same-origin is still a requirement, not a preference — see the note in
 * static.mjs. Behind nginx it is the reverse proxy that provides it, so /auth and
 * /api must be proxied on the site's own hostname, never exposed on a second port.
 *
 * Read the three files it composes in this order:
 *
 *   auth.mjs    the BFF: an HttpOnly session cookie, a CSRF token, an access
 *               window that really does expire.
 *   api.mjs     the resources, with server-side paging, sorting, filtering and
 *               scope enforcement.
 *   events.mjs  the server-sent event stream the live tiles read.
 *
 * State lives in memory and dies with the process, which is the correct lifetime
 * for a fixture. Restart to get the seeded dataset back.
 */

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

import { handleApi } from './api.mjs';
import { startTicker } from './events.mjs';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));

/**
 * @param {string} name
 * @param {string} fallback
 */
function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

const PORT = Number(flag('port', '8100'));
const OPEN = process.argv.includes('--open');
const API_ONLY = process.argv.includes('--api-only');

// Imported here rather than at the top so that --api-only never resolves the
// module: the point of the flag is a deployment where tools/layout.mjs does not
// exist. Top-level await, so the server is not listening before it is decided.
const serveStatic = API_ONLY ? null : (await import('./static.mjs')).serveStatic;

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

  void (async () => {
    try {
      if (await handleApi(request, response, url)) return;
      if (serveStatic === null) {
        // Behind a proxy nothing but /auth and /api should arrive here, so this
        // answers a misconfigured location block rather than a user's URL — JSON,
        // because an HTML body from an API origin is the failure the client
        // reports as "unexpected character at line 1 column 1".
        response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'not_found', path: url.pathname }));
        return;
      }
      await serveStatic(APP_DIR, request, response, url);
    } catch (cause) {
      // One place that turns a thrown handler into a response. Without it a bad
      // request body hangs the socket and the browser reports a network error
      // with nothing in the server log.
      console.error('[example] %s %s failed:', request.method, url.pathname, cause);
      if (!response.headersSent) {
        response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      }
      if (!response.writableEnded) response.end(JSON.stringify({ error: 'internal' }));
    }
  })();
});

const stopTicker = startTicker();

server.listen(PORT, () => {
  const origin = `http://localhost:${String(PORT)}`;
  console.log('example  %s', origin);
  console.log('         sign in with any username; the password picks the role:');
  console.log('           admin     administrator — every scope, including users:write');
  console.log('           operator  operator — read plus sales/inventory writes, no user admin');
  console.log('           viewer    viewer — read only, and no analytics:read, so /analytics is refused');
  if (OPEN) {
    void import('node:child_process').then(({ spawn }) => {
      const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      spawn(command, [origin], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
    });
  }
});

for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
  process.on(signal, () => {
    stopTicker();
    server.close(() => process.exit(0));
    // An open event stream is a live connection; without this the process waits
    // for a subscriber that will never disconnect on its own.
    server.closeAllConnections();
  });
}
