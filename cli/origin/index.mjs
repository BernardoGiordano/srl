/**
 * One application origin. Node only, zero dependencies.
 *
 * Serving one srl application is a small, exact set of rules. Resolve a URL through
 * an ordered mount table, refuse anything that climbs out of a mount, answer a
 * directory with its `index.html`, fall back to the application document for a
 * navigation, and name the type by extension. Four servers in this repository need
 * that set, which are `cli/dev/serve.mjs`, `tools/benchmark/origin.mjs`,
 * `cli/test/support/artifact-origin.mjs` and the mount middleware in
 * `web-test-runner.config.mjs`. ADR-0075.
 *
 * This module owns the rules. Each of the four states only what makes it different,
 * through four options.
 *
 *   route       the adapter's own endpoints, consulted before anything static
 *   transform   a body to send instead of the file's bytes
 *   headers     extra response headers for a static hit
 *   fallback    the document a navigation with no file gets
 *
 * Admission comes before all of them. A request whose Host names another site is
 * refused before any route or mount sees it, because a page that rebinds its own
 * hostname to 127.0.0.1 is otherwise a same-origin reader of everything served here.
 * `allowedHosts` names any hostname beyond the loopback names and IP literals.
 * ADR-0131.
 *
 * Conditional requests are this module's rather than an option, because they are a
 * rule about files rather than a policy. A file streamed from disk is sent with an
 * `ETag`, and an `If-None-Match` naming it is answered 304. Whether a browser ever
 * asks is the adapter's `headers`, where `no-store` means it never will and
 * `no-cache` means it will on every reload. ADR-0081.
 *
 * There is no proxy option, and there must not be one. The development server's
 * `--proxy` matters (ADR-0075) and it is one adapter's concern. It lives in that
 * adapter's `route`, which is consulted before the method check and before the
 * mounts for exactly the reason a proxy needs, because a `POST /api/session` must
 * not be answered 405 by a server that is right to refuse a `POST` of a stylesheet.
 * An origin whose interface grew a `proxy` parameter would carry one caller's
 * deployment in every caller's signature.
 *
 * Published, unlike the four servers it stands in for. A repository that installs
 * the toolchain gets `@srljs/core/testing/harness.js`, and this is what runs it.
 */

import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
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
 * Derived from size and mtime rather than from a hash, which is what nginx does and
 * for the same reason. Answering a conditional request must not cost reading the
 * file the answer says not to send. Weak, because that is what a validator built
 * from metadata is, and `If-None-Match` is compared weakly in any case, so nothing
 * is lost by saying so.
 *
 * Only the streamed path gets one. A `transform` returns bytes this module did not
 * read, and stat cannot speak for them. A body that also depends on the adapter's
 * configuration would be revalidated against a file whose mtime that configuration
 * does not change. A transform that wants revalidation states its own `ETag` in
 * `Representation.headers`, where it knows what it built.
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
 * comparison is the weak one RFC 9110 requires for this header. `W/"x"` and `"x"`
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
 * A Host header, split into the hostname it names. Null when the value is not a
 * plain host and port, such as one carrying userinfo or a path.
 *
 * @param {string | undefined} host
 * @returns {string | null}
 */
function hostnameOf(host) {
  if (host === undefined) return null;
  const match = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/iu.exec(host);
  return match === null ? null : /** @type {string} */ (match[1]).toLowerCase();
}

/**
 * Whether this origin answers a request addressed to `host`.
 *
 * DNS rebinding needs a hostname the attacker controls, and the browser sends that
 * hostname as Host. So the loopback names pass, and so does any IP literal, because
 * a browser sends one only when the page's own origin is that address. Browsers
 * resolve `*.localhost` themselves and never ask DNS. Anything else must be listed.
 *
 * @param {string | undefined} host The request's Host header.
 * @param {ReadonlyArray<string>} [allowed] More hostnames, as `allowedHosts` states them.
 * @returns {boolean}
 */
export function admitsHost(host, allowed = []) {
  const hostname = hostnameOf(host);
  if (hostname === null) return false;
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (isIP(hostname.replace(/^\[|\]$/gu, '')) !== 0) return true;
  return allowed.some((name) => name.toLowerCase() === hostname);
}

/**
 * Whether a request came from a page on this origin, or from no page at all.
 *
 * A browser marks a cross-site request with `Sec-Fetch-Site`, and an older one still
 * sends `Origin` on every POST. A request carrying neither came from a tool such as
 * curl, which can already reach a loopback port with any body it likes. An endpoint
 * that acts on what it is sent checks this before reading the body.
 *
 * @param {IncomingMessage} request
 * @returns {boolean}
 */
export function sameOrigin(request) {
  const site = request.headers['sec-fetch-site'];
  if (site !== undefined) return site === 'same-origin';
  const { origin } = request.headers;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

/**
 * Whether a decoded path names a dotfile or a dot directory, such as `/.env` or
 * `/.git/config`. Those hold credentials and history, never something a page loads.
 * `/.well-known/` is the one public namespace that starts with a dot (RFC 8615).
 *
 * @param {string} pathname Already percent-decoded.
 * @returns {boolean}
 */
export function hidden(pathname) {
  return pathname.split('/').some((segment) => segment.startsWith('.') && segment !== '.well-known');
}

/**
 * Which mount claims a path, and what is left of the path after the prefix.
 *
 * Pure string work over an already-decoded path, so the same table serves a file
 * server and the test runner's URL rewrite, which is the one consumer that maps a
 * prefix to another prefix rather than to a directory.
 *
 * Matching is on a segment boundary. A prefix ending in `/` matches by being one, so
 * `/libraries` cannot be taken for `/lib/`. A prefix that is a whole path, such as
 * the test runner's `/app.manifest.json`, matches itself and nothing it happens to
 * be a substring of. `/` matches everything, which is why it is declared last.
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
 * The file a URL path resolves to inside one of the mounts, and that mount's
 * directory, or null when there is no honest answer.
 *
 * Having several mounts rather than one does not weaken the traversal check. The
 * candidate is re-checked against the directory it resolved into, so
 * `GET /lib/../../.ssh/id_rsa` leaves that mount and is refused rather than climbing
 * out of the repository. A malformed percent escape, an embedded NUL and a dot
 * segment are refused too, because all three are requests a caller can send and
 * none is a 500.
 *
 * @param {string} pathname
 * @param {ReadonlyArray<Mount>} mounts
 * @returns {{ file: string, root: string } | null}
 */
function locate(pathname, mounts) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || hidden(decoded)) return null;

  const match = resolveMount(decoded, mounts);
  if (match === null) return null;

  const root = resolve(match.target);
  const file = resolve(join(root, normalize(match.rest)));
  if (file !== root && !file.startsWith(root + sep)) return null;
  return { file, root };
}

/**
 * The deepest mount directory that holds a file by its path, or null when none does.
 * The history fallback is a file rather than a URL, so this is how it finds the
 * mount it must stay inside.
 *
 * @param {string} file Absolute.
 * @param {ReadonlyArray<Mount>} mounts
 * @returns {string | null}
 */
function owningRoot(file, mounts) {
  const path = resolve(file);
  let owner = null;
  for (const [, target] of mounts) {
    const root = resolve(target);
    if (path !== root && !path.startsWith(root + sep)) continue;
    if (owner === null || root.length > owner.length) owner = root;
  }
  return owner;
}

/**
 * The file a URL path resolves to inside one of the mounts, or null when there is
 * no honest answer. The same string rules as the server applies, before it reads
 * the disk.
 *
 * @param {string} pathname
 * @param {ReadonlyArray<Mount>} mounts
 * @returns {string | null}
 */
export function toFile(pathname, mounts) {
  return locate(pathname, mounts)?.file ?? null;
}

/**
 * Send one body the way the static path does, with a type, a cache policy and a
 * length.
 *
 * Exported for the `route` hooks, which answer requests this module never resolves
 * to a file, such as a generated harness page, an injected test module or a canned
 * 401. None of them should grow its own three-header helper.
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
  const allowedHosts = options.allowedHosts ?? [];
  const fallbackRoot = fallback === null ? null : owningRoot(fallback, mounts);

  /**
   * Each mount's directory with its symlinks resolved, kept once found, because a
   * mount table does not change while it is served.
   *
   * @type {Map<string, string>}
   */
  const realRoots = new Map();

  /**
   * Whether a file that exists stays inside its mount once symlinks are followed.
   * The string check in `locate` cannot see a link inside the mount that points out
   * of it.
   *
   * @param {string} file
   * @param {string} root
   * @returns {Promise<boolean>}
   */
  async function contained(file, root) {
    try {
      let base = realRoots.get(root);
      if (base === undefined) {
        base = await realpath(root);
        realRoots.set(root, base);
      }
      const real = await realpath(file);
      return real === base || real.startsWith(base + sep);
    } catch {
      return false;
    }
  }

  /**
   * @param {IncomingMessage} request
   * @param {ServerResponse} response
   * @returns {Promise<void>}
   */
  async function handle(request, response) {
    // A fixed base, because only the path and the query are this server's business
    // and a caller's Host header must not decide which file is read.
    const url = new URL(request.url ?? '/', 'http://origin.invalid');

    if (!admitsHost(request.headers.host, allowedHosts)) {
      response.writeHead(403, { 'Content-Type': 'text/plain' }).end('Host not allowed');
      return;
    }

    if (route !== null && (await route(request, response, url))) return;

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }

    const located = locate(url.pathname, mounts);
    if (located === null) {
      response.writeHead(403, { 'Content-Type': 'text/plain' }).end('Forbidden');
      return;
    }

    let file = located.file;
    let root = /** @type {string | null} */ (located.root);
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
      root = fallbackRoot;
      stats = await statOrNull(file);
      if (stats === null) {
        response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
    }

    // After every selection, so the directory index and the history fallback meet
    // the rule the file a URL names meets.
    if (root === null || !(await contained(file, root))) {
      response.writeHead(403, { 'Content-Type': 'text/plain' }).end('Forbidden');
      return;
    }

    const representation =
      transform === null ? null : await transform(file, { pathname: url.pathname, request, stats });

    const headers = {
      'Content-Type': contentType(file),
      ...NO_STORE,
      // Before the adapter's, so an adapter that wants a validator of its own for
      // a body it built states one and wins.
      ...(representation === null ? { ETag: entityTag(stats) } : {}),
      ...headersFor(url.pathname, file),
      ...representation?.headers,
    };

    // Why a validator is sent at all, and it is checked for whichever validator is
    // in play, the file's or one a transform stated for the bytes it built.
    // Content-Type is dropped because a 304 carries no representation to type.
    // Everything else the 200 would have said about caching this URL still holds and
    // is repeated, which is what RFC 9110 asks for.
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
 * The listen-and-close dance is the same everywhere. Bind, ask which port that was,
 * refuse a non-TCP address, and close all connections before closing the server.
 * Getting the last part wrong is a suite that hangs after its assertions have
 * passed.
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
