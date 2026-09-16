/**
 *   node example/server/server.mjs [--port 8100] [--open] [--api-only] [--no-watch]
 *
 * This Node server hosts the application, library, API, and authentication on one
 * origin. It keeps example data in memory, so a restart restores the seeded data.
 * `--api-only` runs behind a proxy that serves static files on the same origin.
 * That mode skips the static adapter because a released server omits `cli/`.
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
const WATCH = !process.argv.includes('--no-watch');

// Resolve the static adapter only when it is available in this deployment.
const serveStatic = API_ONLY
  ? null
  : (await import('./static.mjs')).staticOrigin(APP_DIR, { watch: WATCH });

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

  void (async () => {
    try {
      if (await handleApi(request, response, url)) return;
      if (serveStatic === null) {
        // An API-only server answers unexpected paths as JSON.
        response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'not_found', path: url.pathname }));
        return;
      }
      await serveStatic.handle(request, response);
    } catch (cause) {
      // Convert handler failures into responses so requests do not hang.
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
    void serveStatic?.close();
    server.close(() => process.exit(0));
    // Close active event streams before stopping the server.
    server.closeAllConnections();
  });
}
