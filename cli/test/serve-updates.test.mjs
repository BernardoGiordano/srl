import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { planUpdate } from '../dev/update-client.js';
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
    assert.match(document, /import \{ applyUpdate \} from '\/__updates\/client\.js'/);

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
