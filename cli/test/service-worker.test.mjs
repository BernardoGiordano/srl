/**
 * What the generated worker precaches, what it refuses to touch, and what it deletes.
 *
 * Every case is a literal report rather than a built application, for the reason
 * `entry-hints.test.mjs` states: the rule is a function of one report and nothing
 * else, so asserting it needs no Vite, no browser and no artifact on disk.
 *
 * Deletion is the exception, and `activated()` is why. Which caches survive an
 * activation is not a property of the source text. It is what the handler does when
 * an origin hands it a list of names, so that one rule is asserted by running the
 * generated handler against a `CacheStorage` stand-in rather than by matching a
 * regular expression against the file.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';

import { entryClosure } from '../delivery/artifact-report.mjs';
import { WORKER, precacheList, serviceWorkerSource } from '../delivery/service-worker.mjs';

/** @import { ArtifactChunk } from '../delivery/artifact-report.mjs' */

/**
 * @param {string} path
 * @param {Partial<ArtifactChunk>} [rest]
 * @returns {ArtifactChunk}
 */
function chunk(path, rest = {}) {
  return {
    path,
    entry: false,
    dynamicEntry: false,
    facade: null,
    imports: [],
    dynamicImports: [],
    modules: [],
    ...rest,
  };
}

/**
 * The shape every application built by this toolchain has. An entry that statically
 * needs two chunks, one of them transitively, and dynamically imports a root module
 * that brings a third. `orders` is a route chunk, a dynamic import of the root, and
 * is the one the entry document does not preload.
 */
function facts() {
  return {
    app: 'example',
    entry: 'assets/entry-AAAAAAAA.js',
    chunks: [
      chunk('assets/entry-AAAAAAAA.js', {
        entry: true,
        imports: ['assets/reactive-BBBBBBBB.js'],
        dynamicImports: ['assets/app-root-CCCCCCCC.js'],
      }),
      chunk('assets/reactive-BBBBBBBB.js', { imports: ['assets/inject-DDDDDDDD.js'] }),
      chunk('assets/inject-DDDDDDDD.js'),
      chunk('assets/app-root-CCCCCCCC.js', {
        dynamicEntry: true,
        imports: ['assets/signal-EEEEEEEE.js'],
        dynamicImports: ['assets/orders-FFFFFFFF.js'],
      }),
      chunk('assets/signal-EEEEEEEE.js'),
      chunk('assets/orders-FFFFFFFF.js', { dynamicEntry: true }),
    ],
    templateGroups: {
      entry: ['/assets/templates/app-root-0123456789abcdef.html'],
      'chunk:assets/orders-FFFFFFFF.js': ['/assets/templates/orders-fedcba9876543210.html'],
    },
    stylesheet: '/assets/app-11111111.css',
  };
}

void test('the closure is the entry, its statics, and the root module it always imports', () => {
  assert.deepEqual(entryClosure('assets/entry-AAAAAAAA.js', facts().chunks), [
    'assets/app-root-CCCCCCCC.js',
    'assets/entry-AAAAAAAA.js',
    'assets/inject-DDDDDDDD.js',
    'assets/reactive-BBBBBBBB.js',
    'assets/signal-EEEEEEEE.js',
  ]);
});

void test('a route chunk is outside the closure, so it is outside the precache', () => {
  const precache = precacheList(facts());

  assert.ok(!precache.includes('/assets/orders-FFFFFFFF.js'));
  assert.ok(!precache.includes('/assets/templates/orders-fedcba9876543210.html'));
});

void test('the precache is the document, the entry closure and the entry template group', () => {
  assert.deepEqual(precacheList(facts()), [
    '/index.html',
    '/assets/app-11111111.css',
    '/assets/app-root-CCCCCCCC.js',
    '/assets/entry-AAAAAAAA.js',
    '/assets/inject-DDDDDDDD.js',
    '/assets/reactive-BBBBBBBB.js',
    '/assets/signal-EEEEEEEE.js',
    '/assets/templates/app-root-0123456789abcdef.html',
  ]);
});

void test('source delivery has no groups, so the worker precaches code and the document', () => {
  const precache = precacheList({ ...facts(), templateGroups: null });

  assert.deepEqual(precache, [
    '/index.html',
    '/assets/app-11111111.css',
    '/assets/app-root-CCCCCCCC.js',
    '/assets/entry-AAAAAAAA.js',
    '/assets/inject-DDDDDDDD.js',
    '/assets/reactive-BBBBBBBB.js',
    '/assets/signal-EEEEEEEE.js',
  ]);
});

void test('the stylesheet is precached, because a first load requests it before the worker exists', () => {
  assert.ok(precacheList(facts()).includes('/assets/app-11111111.css'));
  assert.ok(!precacheList({ ...facts(), stylesheet: null }).some((url) => url.endsWith('.css')));
});

void test('a report whose entry is not one of its chunks is refused', () => {
  assert.throws(
    () => precacheList({ ...facts(), entry: 'assets/missing-00000000.js' }),
    /not one of its chunks/u,
  );
});

void test('the cache name turns over exactly when the precached bytes do', () => {
  const same = serviceWorkerSource(facts());
  assert.equal(serviceWorkerSource(facts()), same, 'the same artifact generates the same worker');

  const moved = facts();
  moved.chunks[4] = chunk('assets/signal-99999999.js');
  moved.chunks[3] = chunk('assets/app-root-CCCCCCCC.js', {
    dynamicEntry: true,
    imports: ['assets/signal-99999999.js'],
    dynamicImports: ['assets/orders-FFFFFFFF.js'],
  });

  assert.notEqual(serviceWorkerSource(moved), same);
  assert.notEqual(cacheNameOf(serviceWorkerSource(moved)), cacheNameOf(same));
});

void test('the cache is named after the application it belongs to', () => {
  assert.match(cacheNameOf(serviceWorkerSource(facts())), /^srl:example:[0-9a-f]{16}$/u);
});

void test('the worker is a classic script at a fixed URL', () => {
  const source = serviceWorkerSource(facts());

  assert.equal(WORKER, 'sw.js');
  assert.ok(!/^\s*(?:import|export)\s/mu.test(source), 'a module worker would need type: module');
  assert.match(source, /^'use strict';$/mu);
});

void test('it never claims a Remote, an API call or a write', () => {
  const source = serviceWorkerSource(facts());

  // The three conditions that return without responding. Asserted on the source
  // because the alternative is a service worker integration test for a rule that is
  // a property of the text. What this file must not do is answer for bytes it did
  // not build. ADR-0016, ADR-0017, ADR-0026.
  assert.match(source, /request\.method !== 'GET'/u);
  assert.match(source, /url\.origin !== self\.location\.origin/u);
  assert.ok(!source.includes('/remotes/'), 'a Remote is nowhere in the policy');

  // `/remotes/<name>/<version>/assets/...` must not be read as the shell's own
  // immutable assets, which is why the prefix is anchored.
  const immutable = /const IMMUTABLE = (\/.+\/);/u.exec(source)?.[1];
  assert.ok(immutable !== undefined);
  const pattern = new RegExp(immutable.slice(1, -1), 'u');
  assert.ok(pattern.test('/assets/entry-AAAAAAAA.js'));
  assert.ok(!pattern.test('/remotes/sales/1.2.0/assets/remote-entry-AAAAAAAA.js'));
});

void test('it does not skip waiting, so a running tab keeps the worker it started with', () => {
  // On the call rather than the word, because the generated source says in a comment
  // why it does
  // not make one, and that comment is the thing a later reader needs most.
  assert.ok(!/skipWaiting\s*\(/u.test(serviceWorkerSource(facts())));
});

void test('activation retires this Application\'s own old cache', async () => {
  const source = serviceWorkerSource(facts());
  const current = cacheNameOf(source);
  const previous = 'srl:example:0123456789abcdef';

  const { surviving, deleted } = await activated(source, [previous, current]);

  assert.deepEqual(deleted, [previous]);
  assert.deepEqual(surviving, [current], 'the cache the worker just installed was deleted');
});

void test('activation leaves every cache this Application does not own', async () => {
  // An origin is shared. A second Application deployed beside this one, a Remote
  // that caches its own bytes, and a cache a page opened itself all sit in the same
  // `CacheStorage`, and none of them is this worker's to delete. ADR-0016, ADR-0026.
  const source = serviceWorkerSource(facts());
  const current = cacheNameOf(source);
  const foreign = ['srl:another-app:0123456789abcdef', 'remote-billing:v1', 'user-owned-cache'];

  const { surviving, deleted } = await activated(source, [...foreign, current]);

  assert.deepEqual(deleted, []);
  assert.deepEqual(surviving, [...foreign, current]);
});

void test('an Application whose name only starts the same keeps its caches', async () => {
  const source = serviceWorkerSource({ ...facts(), app: 'example' });
  const neighbour = 'srl:example-admin:0123456789abcdef';

  const { deleted } = await activated(source, [neighbour, cacheNameOf(source)]);

  assert.deepEqual(deleted, [], 'the owned prefix matched a longer application name');
});

void test('activation claims the tabs it controls once the retirement is done', async () => {
  const source = serviceWorkerSource(facts());

  const { claimed } = await activated(source, ['srl:example:0123456789abcdef', cacheNameOf(source)]);

  assert.ok(claimed, 'a controlled tab would keep talking to the network until the next load');
});

/**
 * The generated worker, activated against a seeded origin.
 *
 * Enough of a worker global to load the script and fire one lifecycle event. It holds
 * the handlers the script registers, a `CacheStorage` holding `seeded`, and a
 * `clients.claim()` that records it was called. The event's `waitUntil` collects the
 * work, which is how an activation is awaited anywhere. The browser keeps the worker
 * alive until that promise settles, and so does this.
 *
 * @param {string} source
 * @param {readonly string[]} seeded
 * @returns {Promise<{ surviving: string[], deleted: string[], claimed: boolean }>}
 */
async function activated(source, seeded) {
  const surviving = [...seeded];
  /** @type {string[]} */
  const deleted = [];
  let claimed = false;

  /** @type {Map<string, (event: { waitUntil: (work: Promise<unknown>) => void }) => void>} */
  const handlers = new Map();
  const context = createContext({
    self: {
      addEventListener: (/** @type {string} */ type, /** @type {any} */ handler) =>
        handlers.set(type, handler),
      clients: {
        claim: () => {
          claimed = true;
          return Promise.resolve();
        },
      },
      location: { origin: 'https://example.test' },
    },
    caches: {
      keys: () => Promise.resolve([...surviving]),
      delete: (/** @type {string} */ name) => {
        const at = surviving.indexOf(name);
        if (at === -1) return Promise.resolve(false);
        surviving.splice(at, 1);
        deleted.push(name);
        return Promise.resolve(true);
      },
    },
  });
  runInContext(source, context);

  const activate = handlers.get('activate');
  assert.ok(activate !== undefined, 'the generated worker registers an activate handler');

  /** @type {Promise<unknown>[]} */
  const pending = [];
  activate({ waitUntil: (work) => void pending.push(work) });
  await Promise.all(pending);

  return { surviving, deleted, claimed };
}

/** @param {string} source */
function cacheNameOf(source) {
  const name = /const CACHE = "([^"]+)"/u.exec(source)?.[1];
  assert.ok(name !== undefined, 'the generated worker names its cache');
  return name;
}
