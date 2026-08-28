import assert from 'node:assert/strict';
import test from 'node:test';

import { entryHints, withEntryHints } from '../delivery/entry-hints.mjs';

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
 * A shell whose entry statically needs two chunks, one of them transitively, and
 * dynamically imports a root module that brings a third. The same shape every
 * application built by this toolchain has.
 */
function facts() {
  return {
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
        imports: ['assets/reactive-BBBBBBBB.js', 'assets/signal-EEEEEEEE.js'],
        dynamicImports: ['assets/shell-layout-FFFFFFFF.js'],
      }),
      chunk('assets/signal-EEEEEEEE.js'),
      chunk('assets/shell-layout-FFFFFFFF.js', { dynamicEntry: true }),
    ],
    security: {
      importMap: { source: '{}', sha256: 'sha256-AA==' },
      modules: [
        { path: '/assets/entry-AAAAAAAA.js', integrity: 'sha384-entry' },
        { path: '/assets/reactive-BBBBBBBB.js', integrity: 'sha384-reactive' },
        { path: '/assets/inject-DDDDDDDD.js', integrity: 'sha384-inject' },
        { path: '/assets/app-root-CCCCCCCC.js', integrity: 'sha384-root' },
        { path: '/assets/signal-EEEEEEEE.js', integrity: 'sha384-signal' },
      ],
      csp: '',
    },
  };
}

void test('the document names the entry closure, then the root module', () => {
  const hints = entryHints(facts());

  assert.deepEqual(hints, [
    { rel: 'preload', href: '/app.manifest.json', as: 'fetch' },
    { rel: 'modulepreload', href: '/assets/inject-DDDDDDDD.js', integrity: 'sha384-inject' },
    { rel: 'modulepreload', href: '/assets/reactive-BBBBBBBB.js', integrity: 'sha384-reactive' },
    { rel: 'modulepreload', href: '/assets/app-root-CCCCCCCC.js', integrity: 'sha384-root' },
    { rel: 'modulepreload', href: '/assets/signal-EEEEEEEE.js', integrity: 'sha384-signal' },
  ]);
});

void test('a route chunk behind the root module is not named', () => {
  const hrefs = entryHints(facts()).map((hint) => hint.href);
  assert.ok(!hrefs.includes('/assets/shell-layout-FFFFFFFF.js'));
});

void test('the entry chunk is not preloaded beside its own script tag', () => {
  const hrefs = entryHints(facts()).map((hint) => hint.href);
  assert.ok(!hrefs.includes('/assets/entry-AAAAAAAA.js'));
});

void test('a chunk is named once however many importers reach it', () => {
  const hrefs = entryHints(facts()).map((hint) => hint.href);
  assert.equal(hrefs.filter((href) => href === '/assets/reactive-BBBBBBBB.js').length, 1);
});

void test('a report that names an entry it does not carry is refused', () => {
  const broken = { ...facts(), entry: 'assets/missing-00000000.js' };
  assert.throws(() => entryHints(broken), /not one of its chunks/u);
});

void test('every hint carries the digest the import map pins, and CORS mode', () => {
  const html = withEntryHints(
    '<!DOCTYPE html><html><head><script type="importmap">{}</script>' +
      '<script type="module" crossorigin src="/assets/entry-AAAAAAAA.js"></script>' +
      '</head><body><app-root></app-root></body></html>',
    facts(),
  );

  assert.match(
    html,
    /<link rel="modulepreload" href="\/assets\/app-root-CCCCCCCC.js" crossorigin="" integrity="sha384-root">/u,
  );
  assert.match(html, /<link rel="preload" href="\/app.manifest.json" as="fetch" crossorigin="">/u);
  assert.equal((html.match(/rel="modulepreload"/gu) ?? []).length, 4);
});

void test('the hints sit after the import map and before the module that needs them', () => {
  const html = withEntryHints(
    '<!DOCTYPE html><html><head><script type="importmap">{}</script>' +
      '<script type="module" crossorigin src="/assets/entry-AAAAAAAA.js"></script>' +
      '</head><body></body></html>',
    facts(),
  );

  const map = html.indexOf('type="importmap"');
  const first = html.indexOf('rel="preload"');
  const last = html.lastIndexOf('rel="modulepreload"');
  const entry = html.indexOf('type="module"');
  assert.ok(map < first, 'an import map must precede every module load the document starts');
  assert.ok(last < entry, 'a hint after the script it is for starts its transfer too late');
});

void test('a document with no module entry is refused rather than silently unhinted', () => {
  assert.throws(
    () => withEntryHints('<!DOCTYPE html><html><head></head><body></body></html>', facts()),
    /no module entry/u,
  );
});
