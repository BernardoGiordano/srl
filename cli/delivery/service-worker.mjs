/**
 * The cache policy the build already decided, in the one process that can act on it.
 *
 * `cacheClass()` in `build.mjs` decides `immutable` or `revalidate` for every emitted
 * file, `verifyPayload` refuses a build that leaves one unknown, and `artifact.json`
 * carries the answer to four readers: the release, the HTTP verifier, the benchmark's
 * budgets — and, until this module existed, nobody in the browser. A policy stated
 * once at build time and thrown away at the network boundary is the shape this
 * generator closes.
 *
 * WHY GENERATED RATHER THAN WRITTEN
 *
 * The usual arrangement is a bundler plugin that walks the output directory and
 * writes its own file list. That is a second derivation of a fact this repository
 * already derives, admits and validates, and the two drift the first time a naming
 * rule changes on one side. Here the whole input is the report the build just wrote,
 * so the worker cannot precache a URL the artifact does not contain, and it cannot
 * miss one the entry document already preloads: both lists come from `entryClosure`,
 * the same function `entryHints` and `groupTemplates` answer with.
 *
 * WHAT IT DELIBERATELY DOES NOT CACHE
 *
 * A Remote's bytes belong to whoever deployed that Remote (ADR-0016, ADR-0017,
 * ADR-0026). A Remote publishes under `/remotes/<name>/<version>/`, on its own
 * cadence, and a shell that cached it would be holding a copy of a release it does
 * not own past the moment its deployer replaced it. So the fetch handler answers for
 * exactly two shapes — the shell's own hash-named `/assets/`, and the four fixed
 * URLs the shell revalidates — and returns without responding to everything else,
 * which leaves API calls, the event stream and every Remote on the network where
 * they were.
 *
 * Pure: facts in, source out. A precache list is asserted without running Vite over
 * a real application, which is what `entry-hints.mjs` established for the document
 * half of the same question. ADR-0088.
 */

import { createHash } from 'node:crypto';

import { entryClosure } from './artifact-report.mjs';

/** @import { ShellArtifactReport } from './artifact-report.mjs' */

/**
 * Where the worker is emitted, and the URL it must be registered from. Not
 * hash-named, and it cannot be: a registration names one URL for the lifetime of an
 * origin, and a browser that could not find last week's URL would keep last week's
 * worker. It is `revalidate` for the same reason `index.html` is.
 */
export const WORKER = 'sw.js';

/**
 * The entry document, which is also the offline shell. Precached so a navigation
 * that finds no network still gets the application rather than the browser's error
 * page; served network-first whenever there is one, so the copy in the cache is only
 * ever the fallback.
 */
const DOCUMENT = '/index.html';

/**
 * The fixed-URL files startup reads, in the order it reads them. Each is
 * `revalidate` in `cacheClass()`, which is the same statement in HTTP terms: its URL
 * never changes, so a cached copy has to be checked before it is believed.
 *
 * `build.json` is here rather than excluded, and the distinction matters: network
 * first means a running tab still learns about a new release from the network
 * (`@core/application/release.js`), while an offline tab reads the release it
 * started with instead of failing.
 */
const REVALIDATE = [DOCUMENT, '/app.manifest.json', '/build.json'];

/**
 * The facts a worker is derived from. A whole `ShellArtifactReport` satisfies the
 * first three; so does a literal in a test, which is why the subset is named.
 *
 * `templateGroups` is the manifest's half of ADR-0086 rather than the report's — the
 * report says which templates exist, the manifest says which chunk names each — and
 * the build holds both at the moment it calls this. `null` is source delivery, which
 * has no chunks to group by and therefore no entry group to precache.
 *
 * `stylesheet` is the document's own compiled CSS, which `verifyBrowserRoot` has
 * already proved is hash-named, unique and loaded by the entry document. It is not a
 * chunk and reaches no module graph, so nothing else in the build would have named
 * it; without it the offline shell renders unstyled until a later visit happens to
 * put the file in the cache.
 *
 * @typedef {Pick<ShellArtifactReport, 'app' | 'entry' | 'chunks'> & {
 *   templateGroups: Readonly<Record<string, readonly string[]>> | null,
 *   stylesheet: string | null,
 * }} WorkerFacts
 */

/**
 * Everything the worker precaches at install time, as absolute URLs.
 *
 * Four groups and no fifth: the document, its stylesheet, the module closure the
 * entry document already names in a `modulepreload`, and the markup those modules
 * define. That is exactly the set a cold start transfers before its first paint, so
 * an install adds no request a first load did not already make — it stores what the
 * browser fetched anyway under a name a second load can find offline.
 *
 * The stylesheet is in the precache rather than left to the fetch handler because
 * the handler cannot reach it: a first load requests the CSS from the document,
 * before this worker is installed and controlling the page, so first-use caching
 * would not store it until the *second* visit and offline would not work until the
 * third.
 *
 * Route chunks, locale bundles and every other immutable file are absent on purpose.
 * They are cached on first use by the fetch handler, which is the difference between
 * an install that costs one screen's bytes and one that costs the whole application.
 *
 * @param {WorkerFacts} facts
 * @returns {string[]}
 */
export function precacheList(facts) {
  const closure = entryClosure(facts.entry, facts.chunks);
  if (closure.length === 0) {
    throw new Error(
      `service-worker: the report names ${facts.entry}, which is not one of its chunks.`,
    );
  }
  const templates = facts.templateGroups?.entry ?? [];
  const styles = facts.stylesheet === null ? [] : [facts.stylesheet];
  return [DOCUMENT, ...styles, ...closure.map((path) => `/${path}`), ...templates];
}

/**
 * The worker's source, ready to be written to `public/sw.js`.
 *
 * Classic script rather than a module: `register()` defaults to `type: 'classic'`,
 * and a module worker would be one more thing an adopter's registration call has to
 * agree with the build about.
 *
 * @param {WorkerFacts} facts
 * @returns {string}
 */
export function serviceWorkerSource(facts) {
  const precache = precacheList(facts);
  // The cache turns over exactly when the bytes in it do. Naming it after the
  // release would turn it over on every deploy including the ones that changed
  // nothing a visitor downloads, and a build of an uncommitted tree has no release
  // to name it after at all — `ArtifactRelease` is null on both halves there, by
  // design. The list is already the answer: every entry but the document is
  // hash-named, so a changed byte anywhere in the entry closure is a changed name.
  const version = createHash('sha256').update(precache.join('\n')).digest('hex').slice(0, 16);

  return `/*
 * Generated by @srljs/cli from artifact.json. Do not edit: the next build
 * overwrites it, and every URL below is one the build verified it emitted.
 */
'use strict';

const CACHE = ${JSON.stringify(`srl:${facts.app}:${version}`)};
const DOCUMENT = ${JSON.stringify(DOCUMENT)};
const PRECACHE = ${JSON.stringify(precache, null, 2)};
const REVALIDATE = new Set(${JSON.stringify(REVALIDATE)});
const IMMUTABLE = /^\\/assets\\//;
const LOCALE = /^\\/i18n\\/[a-z0-9-]+\\.json$/;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
});

// No skipWaiting. A tab running last week's modules must not have this week's
// worker answer its requests: the two disagree about which hash names what, and
// the swap belongs to a moment the application chooses. See
// @core/application/release.js, which is how a tab learns there is one to choose.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached !== undefined) return cached;
  const response = await fetch(request);
  // Only a complete, same-origin answer. An opaque or failed response stored under
  // an immutable name would be served for a year.
  if (response.ok && response.type === 'basic') await cache.put(request, response.clone());
  return response;
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') await cache.put(request, response.clone());
    return response;
  } catch (cause) {
    const cached = await cache.match(request);
    if (cached !== undefined) return cached;
    throw cause;
  }
}

async function shell(request) {
  try {
    return await fetch(request);
  } catch (cause) {
    const cached = await caches.open(CACHE).then((cache) => cache.match(DOCUMENT));
    if (cached !== undefined) return cached;
    throw cause;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // A navigation is answered by the shell whatever path it names: the router owns
  // every path on this origin, so an offline deep link is the application booting
  // and resolving that URL itself.
  if (request.mode === 'navigate') {
    event.respondWith(shell(request));
    return;
  }

  if (IMMUTABLE.test(url.pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (REVALIDATE.has(url.pathname) || LOCALE.test(url.pathname)) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Everything else — the API, the event stream, and every Remote under its own
  // publication base — goes to the network untouched. Not responding is the point:
  // bytes this artifact did not build are not this worker's to hold.
});
`;
}
