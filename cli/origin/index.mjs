/**
 * One application origin. Node only, zero dependencies.
 *
 * "Serve one srl application" is a small, exact set of rules: resolve a URL
 * through an ordered mount table, refuse anything that climbs out of a mount,
 * answer a directory with its `index.html`, fall back to the application document
 * for a navigation, and name the type by extension. Four servers in this
 * repository implemented that set separately — `cli/dev/serve.mjs`,
 * `tools/benchmark/origin.mjs`, `cli/test/support/artifact-origin.mjs` and the
 * mount middleware in `web-test-runner.config.mjs` — and the traversal guard was
 * copy-pasted between them. ADR-0075.
 *
 * This module owns the rules. Each of the four states only what makes it
 * different, through four options:
 *
 *   route       the adapter's own endpoints, consulted before anything static
 *   transform   a body to send instead of the file's bytes
 *   headers     extra response headers for a static hit
 *   fallback    the document a navigation with no file gets
 *
 * Conditional requests are this module's rather than an option, because they are
 * a rule about files and not a policy: a file streamed from disk is sent with an
 * `ETag`, and an `If-None-Match` naming it is answered 304. Whether a browser ever
 * asks is the adapter's `headers` — `no-store` means it never will, `no-cache`
 * means it will on every reload. ADR-0085.
 *
 * THERE IS NO PROXY OPTION, and there must not be one. The development server's
 * `--proxy` is load-bearing (ADR-0069) and it is one adapter's concern: it lives
 * in that adapter's `route`, which is consulted before the method check and before
 * the mounts for exactly the reason a proxy needs — a `POST /api/session` must not
 * be answered 405 by a server that is right to refuse a `POST` of a stylesheet. An
 * origin whose interface grew a `proxy` parameter would be carrying one caller's
 * deployment in every caller's signature.
 *
 * Published, unlike the four servers it replaces. A repository that installs the
 * toolchain gets `@srljs/core/testing/harness.js` and, until now, nothing to run
 * it against.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

import { contentType } from '../package/interface.mjs';

/** @import { IncomingMessage, ServerResponse } from 'node:http' */
/** @import { ListenOptions, Mount, MountMatch, Origin, OriginOptions, RunningOrigin } from './types.js' */

/**
 * No caching unless a caller says otherwise. A stale module served from memory
 * cache after an edit is the single most confusing failure a buildless setup has,
 * so the default is the safe one and a production cache policy is stated.
 */
const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * A validator for the bytes of one file on disk, so a caller that states a
 * revalidating cache policy gets 304s instead of whole bodies.
 *
 * Derived from size and mtime rather than from a hash, which is what nginx does
 * and for the same reason: answering a conditional request must not cost reading
 * the file the answer says not to send. Weak, because that is what a validator
 * built from metadata honestly is — and `If-None-Match` is compared weakly in any
 * case, so nothing is lost by saying so.
 *
 * Only the streamed path gets one. A `transform` returns bytes this module did
 * not read, and stat cannot speak for them: a body that also depends on the
 * adapter's configuration would be revalidated against a file whose mtime that
 * configuration does not change. A transform that wants revalidation states its
 * own `ETag` in `Representation.headers`, where it knows what it built.
 *
 * @param {import('node:fs').Stats} stats
 * @returns {string}
 */
function entityTag(stats) {
  return `W/"${stats.size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}"`;
}

/**
 * Whether an `If-None-Match` header names the tag we would send.
 *
 * The list form and `*` are both what a browser can legitimately send, and the
 * comparison is the weak one RFC 9110 requires for this header: `W/"x"` and `"x"`
 * are the same entity for the purpose of deciding not to send it again.
 *
 * @param {string | undefined} header
 * @param {string} etag
 * @returns {boolean}
 */
function noneMatch(header, etag) {
  if (header === undefined) return false;
  if (header.trim() === '*') return true;
  /** @param {string} tag */
  const weak = (tag) => tag.trim().replace(/^W\//u, '');
  return header.split(',').some((candidate) => weak(candidate) === weak(etag));
}

/**
 * Which mount claims a path, and what is left of the path after the prefix.
 *
 * Pure string work over an already-decoded path, so the same table serves a file
 * server and the test runner's URL rewrite — the one consumer that maps a prefix
 * to another prefix rather than to a directory.
 *
 * Matching is on a segment boundary. A prefix ending in `/` matches by being one,
 * so `/libraries` cannot be taken for `/lib/`; a prefix that is a whole path —
 * `/app.manifest.json`, which the test runner has — matches itself and nothing it
 * happens to be a substring of. `/` matches everything and is why it is declared
 * last.
 *
 * @param {string} pathname Root-absolute and already percent-decoded.
 * @param {ReadonlyArray<Mount>} mounts
 * @returns {MountMatch | null}
 */
export function resolveMount(pathname, mounts) {
  for (const [prefix, target] of mounts) {
    if (prefix === '/') return { prefix, target, rest: pathname.replace(/^\//u, '') };
    if (prefix.endsWith('/')) {
      if (!pathname.startsWith(prefix)) continue;
      return { prefix, target, rest: pathname.slice(prefix.length) };
    }
    if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
    return { prefix, target, rest: pathname.slice(prefix.length).replace(/^\//u, '') };
  }
  return null;
}

/**
 * The file a URL path resolves to inside one of the mounts, or null when there is
 * no honest answer.
 *
 * The traversal check is not theatre, and having several mounts rather than one
 * does not weaken it: the candidate is re-checked against the directory it
 * resolved into, so `GET /lib/../../.ssh/id_rsa` leaves that mount and is refused
 * rather than climbing out of the repository. Refused, too, rather than crashing:
 * a malformed percent escape and an embedded NUL are both requests a caller can
 * send and neither is a 500.
 *
 * @param {string} pathname
 * @param {ReadonlyArray<Mount>} mounts
 * @returns {string | null}
 */
export function toFile(pathname, mounts) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;

  const match = resolveMount(decoded, mounts);
  if (match === null) return null;

  const dir = resolve(match.target);
  const candidate = resolve(join(dir, normalize(match.rest)));
  if (candidate !== dir && !candidate.startsWith(dir + sep)) return null;
  return candidate;
}

/**
 * Send one body, the way the static path does: a type, a cache policy, a length.
 *
 * Exported for the `route` hooks, which answer requests this module never resolves
 * to a file — a generated harness page, an injected test module, a canned 401 —
 * and should not each grow their own three-header helper.
 *
 * @param {ServerResponse} response
 * @param {{ status?: number, type: string, body: Buffer, headers?: Record<string, string> }} what
 * @returns {void}
 */
export function send(response, what) {
  response.writeHead(what.status ?? 200, {
    'Content-Type': what.type,
    ...NO_STORE,
    ...what.headers,
    'Content-Length': String(what.body.byteLength),
  });
  response.end(what.body);
}

/**
 * Whether a request with no file behind it is a navigation, and so the one kind of
 * request the history fallback may answer with the application document.
 *
 * Both halves matter. A missing `.js` must stay a 404, or a typo in an import
 * silently returns HTML and the error becomes `Unexpected token '<'` somewhere
 * unrelated; and a `fetch` of a missing JSON endpoint must not be handed a page
 * either, which is what the `Accept` half refuses.
 *
 * @param {IncomingMessage} request
 * @param {string} pathname
 * @returns {boolean}
 */
function isNavigation(request, pathname) {
  if (extname(pathname) !== '') return false;
  return (request.headers.accept ?? '').includes('text/html');
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

/**
 * The origin as a request handler, for a caller that owns its own server.
 *
 * @param {OriginOptions} options
 * @returns {Origin}
 */
export function createOrigin(options) {
  const { mounts } = options;
  const fallback = options.fallback ?? null;
  const headersFor = options.headers ?? (() => NO_STORE);
  const transform = options.transform ?? null;
  const route = options.route ?? null;

  /**
   * @param {IncomingMessage} request
   * @param {ServerResponse} response
   * @returns {Promise<void>}
   */
  async function handle(request, response) {
    // A fixed base: only the path and the query are this server's business, and a
    // caller's Host header must not decide which file is read.
    const url = new URL(request.url ?? '/', 'http://origin.invalid');

    if (route !== null && (await route(request, response, url))) return;

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }

    const resolved = toFile(url.pathname, mounts);
    if (resolved === null) {
      response.writeHead(403, { 'Content-Type': 'text/plain' }).end('Forbidden');
      return;
    }

    let file = resolved;
    let stats = await statOrNull(file);

    if (stats?.isDirectory() === true) {
      file = join(file, 'index.html');
      stats = await statOrNull(file);
    }

    if (stats === null) {
      if (fallback === null || !isNavigation(request, url.pathname)) {
        response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
      file = fallback;
      stats = await statOrNull(file);
      if (stats === null) {
        response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
    }

    const representation =
      transform === null ? null : await transform(file, { pathname: url.pathname, request, stats });

    const headers = {
      'Content-Type': contentType(file),
      ...NO_STORE,
      // Before the adapter's, so an adapter that wants a validator of its own —
      // for a body it built — states one and wins.
      ...(representation === null ? { ETag: entityTag(stats) } : {}),
      ...headersFor(url.pathname, file),
      ...representation?.headers,
    };

    // The whole point of sending a validator, and it is checked for whichever
    // validator is in play — the file's, or one a transform stated for the bytes it
    // built. Content-Type is dropped because a 304 carries no representation to
    // type; everything else the 200 would have said about caching this URL still
    // holds and is repeated, which is what RFC 9110 asks for.
    const { ETag: etag } = headers;
    if (etag !== undefined && noneMatch(request.headers['if-none-match'], etag)) {
      const { 'Content-Type': _typed, ...validating } = headers;
      response.writeHead(304, validating).end();
      return;
    }

    if (representation !== null) {
      const { body } = representation;
      response.writeHead(200, { ...headers, 'Content-Length': String(body.byteLength) });
      response.end(request.method === 'HEAD' ? undefined : body);
      return;
    }

    response.writeHead(200, { ...headers, 'Content-Length': String(stats.size) });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    createReadStream(file).pipe(response);
  }

  return { handle };
}

/**
 * The same origin, bound to a port.
 *
 * The listen-and-close dance was written three times too — bind, ask which port
 * that was, refuse a non-TCP address, close all connections before closing the
 * server — and getting the last part wrong is a suite that hangs after its
 * assertions have passed.
 *
 * @param {OriginOptions} options
 * @param {ListenOptions} [listenOptions]
 * @returns {Promise<RunningOrigin>}
 */
export async function serveOrigin(options, listenOptions = {}) {
  const { port = 0, host = '127.0.0.1', failed } = listenOptions;
  const origin = createOrigin(options);

  const server = createServer((request, response) => {
    void origin.handle(request, response).catch((cause) => {
      const body = failed?.(cause, request);
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'text/plain' });
      response.end(body ?? 'Internal error');
    });
  });

  await new Promise((done, refused) => {
    server.once('error', refused);
    if (host === null) server.listen(port, () => done(undefined));
    else server.listen(port, host, () => done(undefined));
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The origin did not bind a TCP port.');
  }

  return {
    url: `http://${host ?? 'localhost'}:${String(address.port)}`,
    port: address.port,
    server,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done(undefined));
      }),
  };
}
