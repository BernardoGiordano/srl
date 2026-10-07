import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { diagnosticFromError, planUpdate, unknownNameDiagnostic } from '../dev/update-client.js';
import { startUpdateSession } from '../dev/updates.mjs';
import { serveApplication } from '../dev/serve.mjs';
import { apps } from '../layout.mjs';
import { serveOrigin } from '../origin/index.mjs';

/**
 * What the development server tells a browser when a file changes.
 *
 * Every assertion here is about something the word "reload" cannot carry. The watcher
 * knows which file an editor wrote, a debounce that makes three writes one event can
 * throw away which files were in it, and a browser that misses an event while
 * reconnecting needs a way to ask what it missed.
 *
 * Each case is one way delivery can be wrong while still looking like it works:
 *
 *   the wrong name      a path on disk announced as a path on disk, which names no
 *                       URL the page ever fetched
 *   a split batch       two files saved together arriving as two updates, the second
 *                       overtaking the first through one connection
 *   a temporary file    the scratch half of an atomic save announced as an edit,
 *                       which the browser answers with the reload this exists to avoid
 *   a silent gap        an edit made while the browser was reconnecting, lost with
 *                       no evidence in either process
 *   a stale session     a restarted server answering a browser's id from the process
 *                       before it, which numbers its batches from 1 as well
 *   a watch that outlives its server
 *
 * Real files, real notifications and a real socket throughout. The subject is what
 * the filesystem reports and what arrives over the wire, and a stubbed watcher would
 * assert the stub.
 */

/** The coalescing window these cases state rather than race. */
const BATCH_MS = 120;

/** Long enough for a filesystem notification on a loaded machine. */
const ARRIVAL_MS = 5000;

/**
 * A temporary application and a temporary library mounted beside it, served by an
 * origin with an update session in front of it. That is the arrangement both adapters
 * build, without the repository's own mounts, which are hundreds of files this has
 * nothing to say about.
 *
 * @param {(context: { base: string, app: string, lib: string, session: import('../dev/updates.mjs').UpdateSession }) => Promise<void>} run
 */
async function withUpdates(run) {
  const root = await mkdtemp(join(tmpdir(), 'srl-updates-'));
  const app = join(root, 'app');
  const lib = join(root, 'lib');
  await mkdir(join(app, 'src'), { recursive: true });
  await mkdir(lib, { recursive: true });
  await writeFile(join(app, 'index.html'), '<html><body><main></main></body></html>');

  /** @type {Array<[string, string]>} */
  const mounts = [
    ['/lib/', lib],
    ['/', app],
  ];
  const session = startUpdateSession({ mounts, batchMs: BATCH_MS });

  const origin = await serveOrigin(
    {
      mounts,
      fallback: join(app, 'index.html'),
      transform: (file) =>
        file === join(app, 'index.html')
          ? { body: Buffer.from(session.inject('<html><body><main></main></body></html>'), 'utf8') }
          : null,
      route: (request, response, url) => session.route(request, response, url),
    },
    { port: 0, host: '127.0.0.1' },
  );

  // macOS replays the notifications for a directory that was created just before the
  // watch on it started, so the fixture's own `mkdir` arrives as an edit. Letting it
  // flush before anything connects is the difference between asserting delivery and
  // asserting the temporary directory.
  await new Promise((resolve) => {
    setTimeout(resolve, BATCH_MS * 3).unref();
  });

  try {
    await run({ base: origin.url, app, lib, session });
  } finally {
    await origin.close();
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * One open event stream, as the frames it delivers.
 *
 * @param {string} base
 * @param {string} [lastEventId]
 */
async function stream(base, lastEventId) {
  const response = await fetch(`${base}/__updates`, {
    headers: lastEventId === undefined ? {} : { 'Last-Event-ID': lastEventId },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);

  const body = /** @type {ReadableStream<Uint8Array>} */ (response.body);
  const frames = (async function* read() {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of body) {
      buffer += decoder.decode(chunk, { stream: true });
      let end = buffer.indexOf('\n\n');
      while (end !== -1) {
        const raw = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);

        /** @type {Record<string, string>} */
        const fields = {};
        for (const line of raw.split('\n')) {
          const at = line.indexOf(':');
          if (at <= 0) continue;
          fields[line.slice(0, at)] = line.slice(at + 1).trim();
        }
        // `retry` opens every stream and carries no update.
        if (fields.data !== undefined) {
          yield { id: fields.id, update: JSON.parse(fields.data) };
        }

        end = buffer.indexOf('\n\n');
      }
    }
  })();

  return {
    /**
     * The next update, or a failure naming what was being waited for. A timeout here
     * is the assertion, because an update that never arrives is the bug.
     *
     * @param {string} what
     * @returns {Promise<{ id: string | undefined, update: { changed?: string[], reload?: boolean } }>}
     */
    async next(what) {
      const timeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`no update for ${what} within ${ARRIVAL_MS} ms`)), ARRIVAL_MS).unref();
      });
      const frame = await Promise.race([frames.next(), timeout]);
      const { value, done } = /** @type {IteratorResult<{ id: string | undefined, update: object }>} */ (frame);
      assert.ok(!done, `the stream ended while waiting for ${what}`);
      return /** @type {{ id: string | undefined, update: { changed?: string[], reload?: boolean } }} */ (value);
    },

    /** Resolves when the server ends the stream, which is what closing owes a tab. */
    async ended() {
      for await (const _frame of frames) continue;
    },

    async close() {
      await body.cancel().catch(() => undefined);
    },
  };
}

void test('a change is announced as the URL the browser knows it by', async () => {
  await withUpdates(async ({ base, app, lib }) => {
    const events = await stream(base);

    await writeFile(join(app, 'src', 'page.html'), '<p>edited</p>');
    const fromApp = await events.next('an application file');
    assert.deepEqual(fromApp.update.changed, ['/src/page.html']);

    await writeFile(join(lib, 'reactive.js'), 'export const x = 1;\n');
    const fromLib = await events.next('a library file');
    assert.deepEqual(fromLib.update.changed, ['/lib/reactive.js']);

    await events.close();
  });
});

void test('files saved together are one update', async () => {
  await withUpdates(async ({ base, app }) => {
    const events = await stream(base);

    await Promise.all([
      writeFile(join(app, 'src', 'one.html'), '<p>one</p>'),
      writeFile(join(app, 'src', 'two.html'), '<p>two</p>'),
      writeFile(join(app, 'src', 'three.css'), '.a{}'),
    ]);

    const update = await events.next('three files saved together');
    assert.deepEqual(update.update.changed, ['/src/one.html', '/src/three.css', '/src/two.html']);

    await events.close();
  });
});

void test('an atomic save announces the file, not the scratch name', async () => {
  await withUpdates(async ({ base, app }) => {
    const events = await stream(base);

    // What an editor that saves atomically does. Write beside the file, then rename
    // onto it. Only the rename is the edit.
    const scratch = join(app, 'src', 'page.html.tmp');
    await writeFile(scratch, '<p>edited</p>');
    await rename(scratch, join(app, 'src', 'page.html'));

    const update = await events.next('an atomic save');
    assert.deepEqual(update.update.changed, ['/src/page.html']);

    await events.close();
  });
});

void test('a reconnecting browser is told what it missed', async () => {
  await withUpdates(async ({ base, app }) => {
    const first = await stream(base);
    await writeFile(join(app, 'src', 'seen.html'), '<p>seen</p>');
    const seen = await first.next('the edit before the gap');
    assert.deepEqual(seen.update.changed, ['/src/seen.html']);
    assert.ok(seen.id !== undefined, 'an update carries no id to reconnect against');
    await first.close();

    // The gap, meaning two edits with nothing listening, which is a browser
    // reconnecting.
    await writeFile(join(app, 'src', 'missed.html'), '<p>missed</p>');
    await new Promise((resolve) => {
      setTimeout(resolve, BATCH_MS * 2).unref();
    });
    await writeFile(join(app, 'src', 'also-missed.css'), '.b{}');
    await new Promise((resolve) => {
      setTimeout(resolve, BATCH_MS * 2).unref();
    });

    const second = await stream(base, seen.id);
    const replay = await second.next('the reconnect replay');
    assert.deepEqual(replay.update.changed, ['/src/also-missed.css', '/src/missed.html']);
    // Carrying the newest id, so a second drop asks from here rather than replaying
    // this same gap again.
    assert.notEqual(replay.id, seen.id);

    await second.close();
  });
});

void test('an id from a previous server is answered with a reload', async () => {
  await withUpdates(async ({ base }) => {
    const events = await stream(base, 'a1b2c3d4.7');
    const update = await events.next('a foreign id');
    assert.deepEqual(update.update, { reload: true });
    await events.close();
  });
});

void test('closing the session ends the streams it is holding open', async () => {
  const root = await mkdtemp(join(tmpdir(), 'srl-updates-'));
  await mkdir(root, { recursive: true });

  const session = startUpdateSession({ mounts: [['/', root]], batchMs: BATCH_MS });
  const origin = await serveOrigin(
    { mounts: [['/', root]], route: (request, response, url) => session.route(request, response, url) },
    { port: 0, host: '127.0.0.1' },
  );

  const events = await stream(origin.url);
  await session.close();

  // Without this the process waits for a subscriber that never disconnects, which is
  // a suite that passes and then hangs.
  await events.ended();

  await origin.close();
  await rm(root, { recursive: true, force: true });
});

void test('the served entry document carries the update client', async () => {
  const app = (await apps()).find((candidate) => candidate.name === 'example');
  assert.ok(app !== undefined, 'the example application is missing');

  const server = await serveApplication({ app, port: 0, host: '127.0.0.1', watch: true });
  try {
    const document = await (await fetch(`${server.url}/`)).text();
    assert.match(document, /new EventSource\('\/__updates'\)/);
    assert.match(document, /import \{ applyUpdate, watchFailures \} from '\/__updates\/client\.js'/);

    // The failure queue comes first in the head, ahead of the import map and every
    // module script, so a failure while the entry evaluates is not lost. ADR-0125.
    const queue = document.indexOf('globalThis.__srlFailures = []');
    assert.ok(queue !== -1 && queue < document.indexOf('<script type="importmap">'));

    const client = await fetch(`${server.url}/__updates/client.js`);
    assert.equal(client.status, 200);
    assert.match(client.headers.get('content-type') ?? '', /text\/javascript/);
    assert.match(await client.text(), /export function planUpdate/);
  } finally {
    await server.close();
  }
});

void test('the client turns changed URLs into what the page should do', () => {
  assert.deepEqual(planUpdate({ changed: ['/src/page.html'] }), {
    reload: false,
    templates: ['/src/page.html'],
    stylesheets: [],
    modules: [],
  });

  assert.deepEqual(planUpdate({ changed: ['/components/style.css'] }), {
    reload: false,
    templates: [],
    stylesheets: ['/components/style.css'],
    modules: [],
  });

  // A module edit is a revision the browser attempts and may refuse. Whether the
  // page can take it is a question about the class in it, which only the page can
  // answer; this side names the file.
  assert.deepEqual(planUpdate({ changed: ['/src/main.js'] }), {
    reload: false,
    templates: [],
    stylesheets: [],
    modules: ['/src/main.js'],
  });

  // One component, edited on both sides, is one update.
  assert.deepEqual(planUpdate({ changed: ['/src/page.html', '/src/page.js'] }), {
    reload: false,
    templates: ['/src/page.html'],
    stylesheets: [],
    modules: ['/src/page.js'],
  });

  // Anything else is still a reload, and it decides the whole batch, because
  // revising a template and then reloading the page spends the revision on a render
  // nobody sees.
  assert.deepEqual(planUpdate({ changed: ['/src/page.html', '/app.manifest.json'] }), {
    reload: true,
    templates: [],
    stylesheets: [],
    modules: [],
  });

  assert.deepEqual(planUpdate({ reload: true }), {
    reload: true,
    templates: [],
    stylesheets: [],
    modules: [],
  });
});

void test('a failure the page posts is printed with the file its URL names', async () => {
  const app = (await apps()).find((candidate) => candidate.name === 'example');
  assert.ok(app !== undefined, 'the example application is missing');

  /** @type {string[]} */
  const lines = [];
  const server = await serveApplication({
    app,
    port: 0,
    host: '127.0.0.1',
    watch: true,
    log: (format, ...values) => lines.push(values.length === 0 ? format : String(values[0])),
  });
  const post = (/** @type {unknown} */ body) =>
    fetch(`${server.url}/__updates/diagnostics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  try {
    const posted = await post({
      severity: 'error',
      code: 'runtime/startup',
      message: 'Application startup failed at step "root": boom',
      url: '/src/main.js',
      line: 12,
      column: 3,
    });
    assert.equal(posted.status, 204);
    assert.ok(
      lines.includes('  FAIL runtime/startup  example/src/main.js:12:3: Application startup failed at step "root": boom'),
      lines.join('\n'),
    );

    // A body that is not a diagnostic is refused, and nothing is printed for it.
    const before = lines.length;
    assert.equal((await post({ severity: 'error', code: 'Not A Code', message: 'x' })).status, 400);
    assert.equal((await post('runtime/startup')).status, 400);
    assert.equal((await fetch(`${server.url}/__updates/diagnostics`)).status, 405);
    assert.equal(lines.length, before);
  } finally {
    await server.close();
  }
});

void test('only a same-origin JSON post is printed, and it prints as one line of text', async () => {
  const app = (await apps()).find((candidate) => candidate.name === 'example');
  assert.ok(app !== undefined, 'the example application is missing');

  /** @type {string[]} */
  const lines = [];
  const server = await serveApplication({
    app,
    port: 0,
    watch: true,
    log: (format, ...values) => lines.push(values.length === 0 ? format : String(values[0])),
  });
  const ESC = '\x1b';
  const BEL = '\x07';
  const payload = JSON.stringify({
    severity: 'error',
    code: 'runtime/startup',
    message: `${ESC}]52;c;Y3VybCB4fHNo${BEL}${ESC}[2J\u202eboom\n  FAIL runtime/startup  forged`,
    url: `/src/main.js${ESC}[8m`,
    line: 1,
    column: 1,
  });
  const post = (/** @type {Record<string, string>} */ headers) =>
    fetch(`${server.url}/__updates/diagnostics`, { method: 'POST', headers, body: payload });

  try {
    // What any page can send without a preflight, and what a page on another origin
    // sends with one.
    assert.equal((await post({ 'Content-Type': 'text/plain', Origin: 'https://attacker.example' })).status, 403);
    assert.equal((await post({ 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await post({ 'Content-Type': 'text/plain', 'Sec-Fetch-Site': 'same-origin' })).status, 415);
    assert.deepEqual(lines, []);

    assert.equal((await post({ 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' })).status, 204);
    assert.equal(lines.length, 1);
    const printed = lines[0] ?? '';
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(printed, /[\u0000-\u001f\u007f-\u009f\u202e]/u);
    assert.equal(
      printed,
      '  FAIL runtime/startup  example/src/main.js\\x1b[8m:1:1: \\x1b]52;c;Y3VybCB4fHNo\\x07\\x1b[2J\\u202eboom\\x0a  FAIL runtime/startup  forged',
    );
  } finally {
    await server.close();
  }
});

void test('a changed file name prints with its controls encoded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'srl-updates-'));
  /** @type {string[]} */
  const lines = [];
  const session = startUpdateSession({
    mounts: [['/', root]],
    batchMs: BATCH_MS,
    log: (format, ...values) => lines.push(values.length === 0 ? format : String(values[0])),
  });
  /** @param {number} ms */
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref());

  try {
    await pause(BATCH_MS * 3);
    await writeFile(join(root, 'x\x1b]0;pwned\x07.html'), 'x');
    const deadline = Date.now() + ARRIVAL_MS;
    while (!lines.some((line) => line.includes('pwned')) && Date.now() < deadline) await pause(20);

    const update = lines.find((line) => line.includes('pwned')) ?? '';
    assert.equal(update, '/x\\x1b]0;pwned\\x07.html');
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});

void test('the client names a failure by its innermost code and its place', () => {
  // The startup error says where the problem surfaced, and its cause says what it is.
  const cause = Object.assign(new Error('Unexpected "+" in /src/page.html'), { code: 'templates/expression-syntax' });
  const startup = Object.assign(new Error('Application startup failed at step "root"', { cause }), {
    code: 'runtime/startup',
  });
  const named = diagnosticFromError(startup, { url: '/src/main.js', line: 4, column: 1 });
  assert.equal(named.code, 'templates/expression-syntax');
  assert.equal(named.message, 'Application startup failed at step "root"');
  assert.deepEqual([named.url, named.line, named.column], ['/src/main.js', 4, 1]);

  // No code anywhere, and no place but the stack.
  const plain = new Error('nope');
  plain.stack = 'Error: nope\n    at render (http://localhost:8000/src/app-root.js:9:15)';
  const uncaught = diagnosticFromError(plain);
  assert.equal(uncaught.code, 'runtime/uncaught');
  assert.deepEqual([uncaught.url, uncaught.line, uncaught.column], ['/src/app-root.js', 9, 15]);

  // A lazy route whose module did not load names the module.
  const lazy = diagnosticFromError(
    new TypeError('Failed to fetch dynamically imported module: http://localhost:8000/src/pages/x.js'),
  );
  assert.equal(lazy.code, 'runtime/module-load');
  assert.equal(lazy.url, '/src/pages/x.js');

  const unknown = unknownNameDiagnostic('missing', 'http://localhost:8000/src/page.html {{ missing }}');
  assert.equal(unknown.severity, 'warning');
  assert.equal(unknown.code, 'runtime/unknown-binding');
  assert.equal(unknown.url, '/src/page.html');
  assert.match(unknown.message, /^\{\{ missing \}\} reads "missing"/);
});
