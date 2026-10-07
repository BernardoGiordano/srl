/**
 * One development update session. What changed on disk, as the URL a browser knows
 * it by, delivered to every tab with that page open.
 *
 * Answering with the word "reload" throws the identity away. The watcher knows which
 * file an editor wrote, and a debounce that turns three writes into one event can
 * lose which files were in it, leaving the browser nothing to do with "something
 * changed" but start the page again. An edited `.html` file is a revision the page
 * can apply
 * ([ADR-0111](../../docs/adr/0111-development-edits-update-the-running-page.md)), and
 * that needs the identity.
 *
 * What this owns, so that neither adapter repeats it:
 *
 *   identity     an absolute path becomes the URL it is served at, by reversing the
 *                same mount table `cli/origin/` resolves forward.
 *   batching     a multi-file save is one update carrying every URL, not one
 *                update per file racing the others through one connection.
 *   the stream   the event stream, the injected tag that reads it, and the module
 *                that decides what each changed URL means.
 *   gaps         a batch carries an id, and a reconnecting browser says which one it
 *                had. Anything it missed is replayed, and anything older than the
 *                retained window, or from a previous process, is a reload.
 *   failures     the way back. The page posts each failure it sees as a diagnostic,
 *                and the session prints it with the file the URL names, so a
 *                blank page reaches the terminal. ADR-0125. Only a same-origin
 *                JSON post is read, and every printed string is encoded, because
 *                any page the developer has open can send one. ADR-0131.
 *   disposal     watchers, the pending timer and open connections all end with
 *                `close()`. Without cancellation a suite that started a server and
 *                closed it would keep a recursive watch of the repository for the
 *                life of the process.
 *
 * Policy about what a change means is not here. The session says
 * `/src/app-root.html` changed, and `update-client.js` decides that an `.html` file
 * is a template revision, a `.css` file is a stylesheet swap, a `.js` file is a
 * component revision and anything else is a reload. ADR-0075 keeps development policy
 * in the development adapter, and this is the seam inside it.
 */

import { readFile, stat, watch } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { error, formatLine, printable, warning } from '../diagnostics/index.mjs';
import { sameOrigin, toFile } from '../origin/index.mjs';

/** @import { IncomingMessage, ServerResponse } from 'node:http' */

/**
 * The stream, and the module the injected tag imports.
 *
 * Under a `__` prefix because these are the two URLs on a development origin that
 * are not files, and an application that wants to serve a file at one of them is
 * already fighting the convention every dev server shares.
 */
const STREAM = '/__updates';
const CLIENT = '/__updates/client.js';
const DIAGNOSTICS = '/__updates/diagnostics';

/** The most a page may post as one diagnostic. A stack trace fits many times over. */
const DIAGNOSTIC_BYTES = 64 * 1024;

const CLIENT_FILE = fileURLToPath(new URL('update-client.js', import.meta.url));

/**
 * Injected into the application's index.html, and only into that, when watching.
 *
 * The connection is here, in plain sight in the page, and the policy is in the
 * module it imports. An inline tag is what a developer finds when they ask what the
 * page is doing, and a module is what a test can import without a browser.
 */
const CLIENT_TAG = `
<script type="module">
  // Development only, injected by cli/dev/updates.mjs. Not present in the file on disk.
  import { applyUpdate, watchFailures } from '${CLIENT}';
  void watchFailures();
  new EventSource('${STREAM}').addEventListener('message', (event) => {
    void applyUpdate(JSON.parse(event.data));
  });
</script>
`;

/**
 * Injected first in the head, so a failure while the entry module evaluates is queued
 * for the client rather than lost. A classic script runs before every module script,
 * and it may precede the import map. `watchFailures` drains the queue and replaces it.
 */
const QUEUE_TAG = `
<script>
  // Development only, injected by cli/dev/updates.mjs. Not present in the file on disk.
  globalThis.__srlFailures = [];
  addEventListener('error', (event) => globalThis.__srlFailures.push(event), true);
  addEventListener('unhandledrejection', (event) => globalThis.__srlFailures.push(event));
</script>
`;

/**
 * What an editor writes beside the file it is saving, rather than the save.
 *
 * A dotfile at any depth covers `.app-root.html.swp` and `.DS_Store` alike. The rest
 * are the temporary halves of an atomic save, which arrives as a write to a scratch
 * name followed by a rename onto the real one. Only the rename is the edit, and
 * announcing the scratch name would hand the browser a URL ending in `.tmp`, which it
 * answers, correctly and uselessly, with a reload.
 *
 * @param {string} filename Relative to a mount, in the platform's separators.
 * @returns {boolean}
 */
function ignored(filename) {
  return filename
    .split(/[/\\]/)
    .some(
      (segment) =>
        segment.startsWith('.') ||
        segment.endsWith('~') ||
        segment.endsWith('.tmp') ||
        segment.includes('___jb_'),
    );
}

/**
 * How many batches are kept for a browser that reconnects. Fifty saves is a long
 * gap for a connection the browser reopens in half a second, and the answer past the
 * end of the window is a reload rather than a wrong answer.
 */
const RETAINED = 50;

/** Editors write a file two or three times in a few milliseconds; this is one save. */
const BATCH_MS = 40;

/**
 * @typedef {object} UpdateSession
 * @property {(html: string) => string} inject The entry document, with the client in it.
 * @property {(request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean>} route
 * @property {() => Promise<void>} close
 */

/**
 * Watch the mounts and deliver what changed.
 *
 * @param {object} options
 * @param {ReadonlyArray<readonly [string, string]>} options.mounts The origin's own table.
 * @param {(format: string, ...values: string[]) => void} [options.log]
 * @param {number} [options.batchMs] The coalescing window. Stated by a test that
 *   asserts a multi-file save is one update, because the alternative is racing a
 *   filesystem notification against a 40 ms timer.
 * @returns {UpdateSession}
 */
export function startUpdateSession(options) {
  const { mounts } = options;
  const log = options.log ?? (() => undefined);
  const batchMs = options.batchMs ?? BATCH_MS;

  /** Open connections, one per browser tab. */
  /** @type {Set<ServerResponse>} */
  const clients = new Set();

  /** One per mount, so `close` can actually stop a recursive watch. */
  /** @type {Set<AbortController>} */
  const watchers = new Set();

  /** URLs changed since the last batch went out. */
  /** @type {Set<string>} */
  const pending = new Set();

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let batchTimer;

  /**
   * Sent batches, newest last, for a browser that reconnects across one.
   *
   * @type {Array<{ id: string, urls: string[] }>}
   */
  const history = [];

  /**
   * This process. A browser that reconnects to a restarted server holds an id from
   * the process before it, and the ids alone cannot say so, because they start again
   * at 1. The token is what makes "I have seen 7" answerable, and a mismatch is a
   * reload, which is the right answer, because the server restarted when something
   * it reads changed.
   */
  const token = randomUUID().slice(0, 8);
  let counter = 0;

  let closed = false;

  /* ── Identity ────────────────────────────────────────────────────────── */

  /**
   * The mount table read backwards, longest target first, so a directory mounted
   * inside another answers for its own files. The forward resolution takes the first
   * prefix that matches; this is the same rule seen from the other end.
   */
  const byDepth = [...mounts].sort(([, left], [, right]) => right.length - left.length);

  /**
   * The URL a file on disk is served at, or null when no mount covers it.
   *
   * @param {string} file Absolute.
   * @returns {string | null}
   */
  function urlFor(file) {
    for (const [prefix, target] of byDepth) {
      if (!file.startsWith(target + sep)) continue;
      const rest = file.slice(target.length + 1).split(sep).join('/');
      return prefix.endsWith('/') ? prefix + rest : `${prefix}/${rest}`;
    }
    return null;
  }

  /* ── Delivery ────────────────────────────────────────────────────────── */

  /**
   * @param {string} id
   * @param {object} payload
   */
  function publish(id, payload) {
    const frame = `id: ${id}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of clients) client.write(frame);
  }

  /** Send everything collected since the timer started, as one update. */
  function flush() {
    if (pending.size === 0) return;
    const urls = [...pending].sort();
    pending.clear();

    counter += 1;
    const id = `${token}.${String(counter)}`;
    history.push({ id, urls });
    if (history.length > RETAINED) history.shift();

    log('  update  %s', printable(urls.join(' ')));
    publish(id, { changed: urls });
  }

  /**
   * A directory is not an edit. `mkdir` and a rename both report the directory as
   * well as what moved inside it, and announcing `/src` hands the browser a URL that
   * is no file, which it answers with the reload this exists to avoid. A file that no
   * longer exists is still announced, because a deleted template is a page that has
   * gone stale and the client's fetch of it is what says so.
   *
   * @param {string} file
   */
  async function changed(file) {
    const url = urlFor(file);
    if (url === null) return;

    const stats = await stat(file).catch(() => null);
    if (stats?.isDirectory() === true) return;

    pending.add(url);
    clearTimeout(batchTimer);
    batchTimer = setTimeout(flush, batchMs);
  }

  /**
   * What a reconnecting browser missed, or null when it missed nothing and undefined
   * when the answer is a reload.
   *
   * @param {string | undefined} lastId
   * @returns {string[] | null | undefined}
   */
  function missedSince(lastId) {
    if (lastId === undefined || lastId === '') return null;
    if (!lastId.startsWith(`${token}.`)) return undefined;

    const at = history.findIndex((batch) => batch.id === lastId);
    if (at === -1) return undefined;

    const urls = new Set();
    for (const batch of history.slice(at + 1)) for (const url of batch.urls) urls.add(url);
    return urls.size === 0 ? null : [...urls].sort();
  }

  /* ── Watching ────────────────────────────────────────────────────────── */

  for (const [, target] of mounts) {
    const controller = new AbortController();
    watchers.add(controller);

    void (async () => {
      try {
        await stat(target);
      } catch {
        return;
      }

      try {
        for await (const event of watch(target, { recursive: true, signal: controller.signal })) {
          if (event.filename === null) continue;
          if (ignored(event.filename)) continue;
          // vendor/ changes are an `npm run vendor` away, never an edit.
          if (event.filename.split(sep)[0] === 'vendor') continue;
          void changed(`${target}${sep}${event.filename}`);
        }
      } catch (cause) {
        if (closed) return;
        log('  watch failed for %s: %s', printable(target), printable(String(cause)));
      }
    })();
  }

  /* ── Failures ────────────────────────────────────────────────────────── */

  /**
   * A diagnostic the page posted, checked and placed, or null when the body is not
   * one. The URL becomes the file it is served from, so the line names what to edit.
   *
   * @param {unknown} value
   * @returns {import('../diagnostics/types.js').Diagnostic | null}
   */
  function pageDiagnostic(value) {
    if (typeof value !== 'object' || value === null) return null;
    const { severity, code, message, url, line, column } = /** @type {Record<string, unknown>} */ (value);
    if (severity !== 'error' && severity !== 'warning') return null;
    if (typeof code !== 'string' || !/^[a-z]+\/[a-z0-9-]+$/u.test(code)) return null;
    if (typeof message !== 'string') return null;

    const position = (/** @type {unknown} */ number) =>
      Number.isInteger(number) && /** @type {number} */ (number) > 0 ? /** @type {number} */ (number) : null;
    const path = typeof url === 'string' && url.startsWith('/') ? url.split('?')[0] ?? url : null;
    const where = {
      group: 'browser',
      file: path === null ? null : (toFile(decodeURIComponent(path), mounts) ?? path),
      line: position(line),
      column: position(column),
    };
    const make = severity === 'error' ? error : warning;
    return make(code, message.slice(0, 4000), where);
  }

  /**
   * @param {IncomingMessage} request
   * @param {ServerResponse} response
   */
  async function receive(request, response) {
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' });
      response.end();
      return;
    }

    // A cross-site page can send a text/plain POST without a preflight. Requiring
    // JSON forces one, which this server never answers, and the origin check covers
    // a browser that skips it.
    if (!sameOrigin(request)) {
      response.writeHead(403);
      response.end();
      return;
    }
    if (!/^application\/json\s*(?:;|$)/iu.test(request.headers['content-type'] ?? '')) {
      response.writeHead(415);
      response.end();
      return;
    }

    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += /** @type {Buffer} */ (chunk).length;
      if (size > DIAGNOSTIC_BYTES) {
        response.writeHead(413);
        response.end();
        return;
      }
      chunks.push(/** @type {Buffer} */ (chunk));
    }

    let diagnostic = null;
    try {
      diagnostic = pageDiagnostic(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch {
      diagnostic = null;
    }
    if (diagnostic === null) {
      response.writeHead(400);
      response.end();
      return;
    }

    log('%s', formatLine(diagnostic));
    response.writeHead(204);
    response.end();
  }

  /* ── The URLs ────────────────────────────────────────────────────────── */

  /**
   * @param {IncomingMessage} request
   * @param {ServerResponse} response
   * @param {URL} url
   * @returns {Promise<boolean>}
   */
  async function route(request, response, url) {
    if (url.pathname === CLIENT) {
      response.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(await readFile(CLIENT_FILE));
      return true;
    }

    if (url.pathname === DIAGNOSTICS) {
      await receive(request, response);
      return true;
    }

    if (url.pathname !== STREAM) return false;

    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    // Half a second rather than the browser's three, because the gap it covers is a
    // developer restarting a server they are watching.
    response.write('retry: 500\n\n');
    clients.add(response);
    request.on('close', () => clients.delete(response));

    const lastId = request.headers['last-event-id'];
    const missed = missedSince(typeof lastId === 'string' ? lastId : undefined);
    if (missed === undefined) {
      response.write('data: {"reload":true}\n\n');
    } else if (missed !== null) {
      // Carrying the newest id, so a browser that drops again asks from where this
      // replay left it rather than replaying the same gap a second time. There is a
      // newest: a gap is measured against batches this session sent.
      const newest = /** @type {{ id: string, urls: string[] }} */ (history.at(-1));
      log('  replay  %s', printable(missed.join(' ')));
      response.write(`id: ${newest.id}\ndata: ${JSON.stringify({ changed: missed })}\n\n`);
    }

    return true;
  }

  /**
   * @param {string} html
   * @returns {string}
   */
  function inject(html) {
    const head = /<head[^>]*>/iu.exec(html);
    const queued =
      head === null
        ? QUEUE_TAG + html
        : html.slice(0, head.index + head[0].length) + QUEUE_TAG + html.slice(head.index + head[0].length);
    return queued.includes('</body>')
      ? queued.replace('</body>', `${CLIENT_TAG}</body>`)
      : queued + CLIENT_TAG;
  }

  async function close() {
    closed = true;
    clearTimeout(batchTimer);
    for (const controller of watchers) controller.abort();
    watchers.clear();
    for (const client of clients) client.end();
    clients.clear();
    // One turn, so an aborted watcher's rejection lands here rather than in whatever
    // ran after the server closed.
    await Promise.resolve();
  }

  return { inject, route, close };
}
