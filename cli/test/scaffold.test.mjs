import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { errors, hasErrors } from '../diagnostics/index.mjs';
import { applicationFiles, emitApplication } from '../scaffold/application.mjs';

/**
 * The application shape.
 *
 * Nine files, each of them a contract enforced somewhere else in this toolchain: the
 * eight facts the production HTML transform requires, an import map that must carry the
 * library's fragment, two JavaScript chunks, a manifest the library admits, a stylesheet
 * that reaches the installed package, a tsconfig extending the published base. The probe
 * in tools/checks/pack-check.mjs proves the whole set builds; what is asserted here is
 * the shape itself, which needs no install, no tarball and no subprocess. ADR-0073.
 */

/** The facts, spelled out, so the pure half is testable without a library on disk. */
const FACTS = {
  name: 'web',
  importMap: '{\n  "imports": {\n    "@core/": "/lib/core/"\n  }\n}\n',
  tailwindUrl: '/lib/vendor/tailwind-browser.js',
  tailwindIntegrity: 'sha384-abc',
  stylesheetUrls: ['/components/style.css', '/components/theme-default.css'],
  stylesheetPaths: [
    '../../node_modules/@srljs/core/components/style.css',
    '../../node_modules/@srljs/core/components/theme-default.css',
  ],
};

void test('the shape is nine files, and the eight document facts are in the document', () => {
  const files = applicationFiles(FACTS);

  assert.deepEqual(
    [...files.keys()],
    [
      'web/index.html',
      'web/src/main.js',
      'web/src/main.html',
      'web/src/detail.js',
      'web/src/detail.html',
      'web/src/app.css',
      'web/i18n/en.json',
      'web/app.manifest.json',
      'tsconfig.json',
    ],
  );

  const html = files.get('web/index.html') ?? '';

  // ADR-0041: exactly one of each, and the transform refuses the document otherwise.
  for (const fact of [
    '<link rel="stylesheet" href="/components/style.css" />',
    '<link rel="stylesheet" href="/components/theme-default.css" />',
    '<script type="importmap">',
    '<style type="text/tailwindcss">',
    '<script type="module" src="/src/main.js"></script>',
    '<app-root></app-root>',
    '<noscript>',
  ]) {
    assert.equal(html.split(fact).length, 2, `${fact} appears once`);
  }
});

void test('the import map is the library fragment, pasted, and the script hashed', () => {
  const html = applicationFiles(FACTS).get('web/index.html') ?? '';

  // Pasted rather than assembled: a specifier or a hash written here would be a second
  // copy of the library's own interface, free to drift from it.
  assert.match(
    html,
    /<script type="importmap">\n\{\n {2}"imports": \{\n {4}"@core\/": "\/lib\/core\/"/u,
  );

  // `srl check importmap` requires an integrity attribute on anything vendored, because
  // a classic script carries its hash there rather than in the map.
  assert.match(
    html,
    /<script src="\/lib\/vendor\/tailwind-browser\.js" integrity="sha384-abc"><\/script>/u,
  );
});

void test('the entry has a lazy chunk, because the build refuses one without', () => {
  const files = applicationFiles(FACTS);
  const main = files.get('web/src/main.js') ?? '';

  assert.match(main, /await import\('\.\/detail\.js'\)/u);
  assert.ok(files.has('web/src/detail.js'));

  // A template per component, and both bind something the checker has to resolve
  // against the class beside it.
  assert.match(files.get('web/src/main.html') ?? '', /\{\{ count \}\}/u);
  assert.match(files.get('web/src/detail.html') ?? '', /\{\{ title \}\}/u);
});

void test('the manifest is the smallest one the library admits, and the tsconfig extends', () => {
  const files = applicationFiles(FACTS);

  assert.deepEqual(JSON.parse(files.get('web/app.manifest.json') ?? ''), {
    auth: { apiBaseUrl: '/api' },
    i18n: { defaultLocale: 'en', supportedLocales: ['en'], bundles: ['/i18n/{locale}.json'] },
    remotes: [],
  });

  // ADR-0068: extended, never copied. Four path mappings restated here would be a
  // second table, free to drift from the import map.
  assert.deepEqual(JSON.parse(files.get('tsconfig.json') ?? ''), {
    extends: '@srljs/core/tsconfig.base.json',
    compilerOptions: { types: ['node'] },
    include: ['web/**/*.js'],
  });

  // The stylesheet reaches into the package by node_modules path, which is what an
  // application's own stylesheet does and what a Tailwind resolve error is about.
  assert.match(
    files.get('web/src/app.css') ?? '',
    /@import '\.\.\/\.\.\/node_modules\/@srljs\/core\/components\/style\.css';/u,
  );
});

void test('the name is one directory segment, and never a directory the tools skip', async () => {
  const root = await mkdtemp(join(tmpdir(), 'srl-scaffold-'));
  try {
    for (const name of [undefined, '', 'Web', 'web/app', '../escape', 'web_app']) {
      const found = await emitApplication(root, { name });
      assert.deepEqual(
        errors(found).map((diagnostic) => diagnostic.code),
        ['new/name'],
        `refused ${JSON.stringify(name)}`,
      );
    }

    // An application in one of these would be an application nothing ever builds:
    // cli/layout.mjs skips them, so `srl build --app dist` could not find it.
    // `node_modules` is refused one step earlier, by the name shape above.
    for (const name of ['dist', 'source', 'cli', 'tools', 'coverage']) {
      const found = await emitApplication(root, { name });
      assert.deepEqual(
        errors(found).map((diagnostic) => diagnostic.code),
        ['new/reserved-name'],
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('an existing directory is refused whole, and an existing tsconfig is kept', async () => {
  const root = await mkdtemp(join(tmpdir(), 'srl-scaffold-'));
  try {
    const written = await emitApplication(root, { name: 'web' });
    assert.equal(hasErrors(written), false);

    // Every path the pure half describes is on disk, and says so as a finding.
    assert.deepEqual(
      written.map((diagnostic) => diagnostic.message),
      [...applicationFiles({ ...FACTS, name: 'web' }).keys()],
    );
    const html = await readFile(join(root, 'web', 'index.html'), 'utf8');
    assert.match(html, /<app-root><\/app-root>/u);

    // A second run overwrites nothing: a merge would leave a repository in a shape
    // neither the command nor its author described.
    const again = await emitApplication(root, { name: 'web' });
    assert.deepEqual(
      errors(again).map((diagnostic) => diagnostic.code),
      ['new/exists'],
    );

    // A repository adding its second application already has a tsconfig, and it is
    // theirs. Reported, not replaced.
    const second = await emitApplication(root, { name: 'admin' });
    assert.equal(hasErrors(second), false);
    const kept = second.filter((diagnostic) => diagnostic.code === 'new/tsconfig-kept');
    assert.equal(kept.length, 1);
    assert.match(kept[0]?.message ?? '', /admin\/\*\*\/\*\.js/u);
    const tsconfig = JSON.parse(await readFile(join(root, 'tsconfig.json'), 'utf8'));
    assert.deepEqual(tsconfig.include, ['web/**/*.js']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('an application directory that exists but is empty is still refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'srl-scaffold-'));
  try {
    await mkdir(join(root, 'web'), { recursive: true });
    await writeFile(join(root, 'web', 'notes.txt'), 'mine\n');

    const found = await emitApplication(root, { name: 'web' });
    assert.deepEqual(
      errors(found).map((diagnostic) => diagnostic.code),
      ['new/exists'],
    );
    assert.equal(await readFile(join(root, 'web', 'notes.txt'), 'utf8'), 'mine\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
