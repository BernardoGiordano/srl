/**
 * The static half of this application's server: the same three mounts the dev
 * server and the deployment serve.
 *
 *   /             example/            this application
 *   /lib/         source/lib/         the framework
 *   /components/  source/components/  the shared collection
 *
 * The mount table itself is not restated here — `tools/layout.mjs` owns it and
 * `urlToFile()` resolves a browser URL the same way `tools/dev/serve.mjs` and a
 * production static server do. That matters more than the twenty lines it
 * saves: an application whose server disagreed with the import map about where
 * `/lib/` is would fail only in this application, and only at runtime.
 *
 * Why this application serves its own files at all, rather than `npm start` doing
 * it: the API, the auth cookie and the event stream must be same-origin with the
 * page. `SameSite=Strict` on the session cookie, `grants.api` comparing a remote's
 * request against a pathname, and `EventSource` inheriting the cookie all stop
 * working the moment the API is on a second port. One origin is the requirement;
 * one process is the simplest way to have it.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';

import { contentType, urlToFile } from '../../tools/package/interface.mjs';

/** @import { IncomingMessage, ServerResponse } from 'node:http' */

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

/**
 * @param {string} appDir
 * @param {IncomingMessage} request
 * @param {ServerResponse} response
 * @param {URL} url
 */
export async function serveStatic(appDir, request, response, url) {
  const method = (request.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end();
    return;
  }

  // `..` is resolved by the URL parser before it reaches here, so a traversal
  // attempt arrives already normalised. The explicit check covers an encoded one.
  if (url.pathname.includes('..')) {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Bad request.\n');
    return;
  }

  const file = urlToFile(appDir, url.pathname);
  const found = await statOrNull(file);

  if (found?.isFile() === true) {
    send(response, file, found.size, method);
    return;
  }

  /*
   * History fallback. A deep link like /sales/orders/OR-00007 is not a file: the
   * router resolves it in the browser, so the server answers with index.html and
   * the application takes it from there.
   *
   * Restricted to paths with no extension. Without that, a mistyped module
   * specifier returns HTML with a JavaScript content type and the browser reports
   * "Unexpected token '<'" instead of a 404 — the single most confusing failure
   * mode a history-fallback server has.
   */
  if (extname(url.pathname) === '') {
    const index = urlToFile(appDir, '/index.html');
    const indexStat = await statOrNull(index);
    if (indexStat?.isFile() === true) {
      send(response, index, indexStat.size, method, 200);
      return;
    }
  }

  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(`Not found: ${url.pathname}\n`);
}

/**
 * @param {ServerResponse} response
 * @param {string} file
 * @param {number} size
 * @param {string} method
 * @param {number} [status]
 */
function send(response, file, size, method, status = 200) {
  response.writeHead(status, {
    'Content-Type': contentType(file),
    'Content-Length': String(size),
    // Development: never cache. A cached template or module is the reason a change
    // "did not take effect".
    'Cache-Control': 'no-store',
  });
  if (method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(file).pipe(response);
}
