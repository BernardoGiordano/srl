import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { errors, hasErrors } from '../diagnostics/index.mjs';
import { applicationFiles, emitApplication } from '../scaffold/application.mjs';
import { componentClassName, componentFiles, emitComponent } from '../scaffold/component.mjs';
import { emitProject, projectFiles } from '../scaffold/project.mjs';

/**
 * The project, application and component shapes.
 *
 * Each file is a contract enforced somewhere else in this toolchain. The probe in
 * tools/checks/pack-check.mjs installs, checks and builds what `srl new` and
 * `srl generate` write. These tests assert the shapes themselves, which needs no
 * install, no tarball and no subprocess. ADR-0073, ADR-0122.
 */

/** The facts, spelled out, so the pure halves are testable without a library on disk. */
const APP = {
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

const PROJECT = {
  name: 'my-app',
  core: '1.2.3',
  cli: '1.2.3',
  tools: { tailwindcss: '4.0.0', '@types/node': '24.0.0', '@tailwindcss/cli': '4.0.0' },
  app: APP,
};

/** @param {(dir: string) => Promise<void>} body @returns {Promise<void>} */
async function inTemporary(body) {
  const dir = await mkdtemp(join(tmpdir(), 'srl-scaffold-'));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** @param {readonly import('../diagnostics/types.js').Diagnostic[]} found */
function codes(found) {
  return errors(found).map((diagnostic) => diagnostic.code);
}

/* ── The application ─────────────────────────────────────────────────────── */

void test('an application is eleven files, and the eight document facts are in the document', () => {
  const files = applicationFiles(APP);

  assert.deepEqual(
    [...files.keys()],
    [
      'web/index.html',
      'web/app.manifest.json',
      'web/i18n/en.json',
      'web/src/main.js',
      'web/src/app-root.js',
      'web/src/app-root.html',
      'web/src/routes.js',
      'web/src/pages/home-page.js',
      'web/src/pages/home-page.html',
      'web/src/app.css',
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
  const html = applicationFiles(APP).get('web/index.html') ?? '';

  // Pasted rather than assembled, so no specifier or hash here can drift.
  assert.match(
    html,
    /<script type="importmap">\n\{\n {2}"imports": \{\n {4}"@core\/": "\/lib\/core\/"/u,
  );

  // `srl check importmap` requires an integrity attribute on a vendored classic script.
  assert.match(
    html,
    /<script src="\/lib\/vendor\/tailwind-browser\.js" integrity="sha384-abc"><\/script>/u,
  );
});

void test('the application boots through startup, the router and a lazy page', () => {
  const files = applicationFiles(APP);

  // Startup fetches the manifest and loads the locale bundle before the root, and the
  // root module is a chunk of its own.
  const main = files.get('web/src/main.js') ?? '';
  assert.match(main, /await startApplication\(\{/u);
  assert.match(main, /import\('\.\/app-root\.js'\)\.then\(\(m\) => m\.AppRoot\)/u);

  // The router renders into the root's <main>, and the one route loads its page lazily,
  // which gives the build more than one chunk.
  assert.match(files.get('web/src/app-root.js') ?? '', /attachRouter\(this, routes\)/u);
  assert.match(files.get('web/src/app-root.html') ?? '', /^<main\b/u);
  assert.match(
    files.get('web/src/routes.js') ?? '',
    /\{ path: '', load: \(\) => import\('\.\/pages\/home-page\.js'\)\.then\(\(m\) => m\.HomePage\) \}/u,
  );

  // The page binds members the checker resolves against its class.
  const page = files.get('web/src/pages/home-page.html') ?? '';
  assert.match(page, /\{\{ heading \}\}/u);
  assert.match(page, /\{\{ count \}\}/u);
  assert.match(page, /\(click\)="increment\(\)"/u);
});

void test('every message the locale bundle holds is one the application asks for', () => {
  const files = applicationFiles(APP);
  const bundle = JSON.parse(files.get('web/i18n/en.json') ?? '');
  const source = [...files.values()].join('\n');

  const keys = Object.entries(bundle).flatMap(([group, messages]) =>
    Object.keys(/** @type {object} */ (messages)).map((key) => `${group}.${key}`),
  );
  assert.deepEqual(keys, ['home.title', 'home.intro']);
  for (const key of keys) assert.ok(source.includes(`t('${key}')`), `${key} is referenced`);
});

void test('the manifest is the smallest one the library admits, and the tsconfig extends', () => {
  const files = applicationFiles(APP);

  assert.deepEqual(JSON.parse(files.get('web/app.manifest.json') ?? ''), {
    auth: { apiBaseUrl: '/api' },
    i18n: { defaultLocale: 'en', supportedLocales: ['en'], bundles: ['/i18n/{locale}.json'] },
    remotes: [],
  });

  // ADR-0068: extended, never copied.
  assert.deepEqual(JSON.parse(files.get('tsconfig.json') ?? ''), {
    extends: '@srljs/core/tsconfig.base.json',
    compilerOptions: { types: ['node'] },
    include: ['web/**/*.js'],
  });

  assert.match(
    files.get('web/src/app.css') ?? '',
    /@import '\.\.\/\.\.\/node_modules\/@srljs\/core\/components\/style\.css';/u,
  );
});

void test('an application name is one directory segment, and never one the tools skip', async () => {
  await inTemporary(async (root) => {
    for (const name of [undefined, '', 'Web', 'web/app', '../escape', 'web_app']) {
      assert.deepEqual(codes(await emitApplication(root, { name })), ['scaffold/name'], `refused ${JSON.stringify(name)}`);
    }

    // cli/layout.mjs skips these, so nothing would ever build an application there.
    for (const name of ['dist', 'source', 'cli', 'tools', 'coverage']) {
      assert.deepEqual(codes(await emitApplication(root, { name })), ['scaffold/reserved-name']);
    }
    assert.deepEqual(await readdir(root), []);
  });
});

void test('an existing application directory is refused whole, and an existing tsconfig is kept', async () => {
  await inTemporary(async (root) => {
    const written = await emitApplication(root, { name: 'web' });
    assert.equal(hasErrors(written), false);
    assert.deepEqual(
      written.map((diagnostic) => diagnostic.message),
      [...applicationFiles({ ...APP, name: 'web' }).keys()],
    );

    assert.deepEqual(codes(await emitApplication(root, { name: 'web' })), ['scaffold/exists']);

    // A directory with anything in it is somebody's, even without an index.html.
    await mkdir(join(root, 'notes'));
    await writeFile(join(root, 'notes', 'todo.txt'), 'mine\n');
    assert.deepEqual(codes(await emitApplication(root, { name: 'notes' })), ['scaffold/exists']);
    assert.equal(await readFile(join(root, 'notes', 'todo.txt'), 'utf8'), 'mine\n');

    // A project adding its second application already has a tsconfig, and it is theirs.
    const second = await emitApplication(root, { name: 'admin' });
    assert.equal(hasErrors(second), false);
    const kept = second.filter((diagnostic) => diagnostic.code === 'scaffold/tsconfig-kept');
    assert.equal(kept.length, 1);
    assert.match(kept[0]?.message ?? '', /admin\/\*\*\/\*\.js/u);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'tsconfig.json'), 'utf8')).include, ['web/**/*.js']);
  });
});

/* ── The project ─────────────────────────────────────────────────────────── */

void test('a project is its manifest, ignore file and agent notes around one application', () => {
  const files = projectFiles(PROJECT);

  assert.deepEqual(
    [...files.keys()],
    ['package.json', '.gitignore', 'AGENTS.md', ...applicationFiles(APP).keys()],
  );

  // The pair pinned exactly to each other, and the tools the build shells out to.
  assert.deepEqual(JSON.parse(files.get('package.json') ?? ''), {
    name: 'my-app',
    private: true,
    type: 'module',
    version: '0.0.0',
    engines: { node: '>=22' },
    scripts: {
      dev: 'srl serve --app web',
      check: 'srl check',
      build: 'srl build --app web',
    },
    dependencies: { '@srljs/core': '1.2.3' },
    devDependencies: {
      '@srljs/cli': '1.2.3',
      '@tailwindcss/cli': '4.0.0',
      '@types/node': '24.0.0',
      tailwindcss: '4.0.0',
    },
  });

  // `git add .` must not commit the install or the build.
  assert.deepEqual((files.get('.gitignore') ?? '').trim().split('\n'), ['node_modules/', 'dist/']);

  // The agent file names the loop and where the installed documentation is.
  const agents = files.get('AGENTS.md') ?? '';
  for (const fact of [
    'npx --no-install srl check --json',
    'npx --no-install srl check --codes',
    'node_modules/@srljs/core/llms.txt',
    'node_modules/@srljs/cli/docs/reference/diagnostic-codes.md',
    '`web/index.html`',
  ]) {
    assert.ok(agents.includes(fact), `AGENTS.md mentions ${fact}`);
  }
});

void test('a new project is a new directory, reaching the library through its own install', async () => {
  await inTemporary(async (parent) => {
    const found = await emitProject(parent, { name: 'my-app' });
    assert.equal(hasErrors(found), false);

    const root = join(parent, 'my-app');
    const css = await readFile(join(root, 'web', 'src', 'app.css'), 'utf8');
    assert.match(css, /^@import '\.\.\/\.\.\/node_modules\/@srljs\/core\/components\/style\.css';$/mu);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).scripts.dev, 'srl serve --app web');

    // `--app` renames the application, and the scripts follow it.
    assert.equal(hasErrors(await emitProject(parent, { name: 'other', app: 'site' })), false);
    const other = JSON.parse(await readFile(join(parent, 'other', 'package.json'), 'utf8'));
    assert.equal(other.scripts.build, 'srl build --app site');
    assert.ok((await readdir(join(parent, 'other'))).includes('site'));
  });
});

void test('a project name is one segment, its application name is one the tools read, and it is new', async () => {
  await inTemporary(async (parent) => {
    for (const name of [undefined, '', 'My-App', 'a/b', '../up']) {
      assert.deepEqual(codes(await emitProject(parent, { name })), ['scaffold/name'], `refused ${JSON.stringify(name)}`);
    }
    assert.deepEqual(codes(await emitProject(parent, { name: 'my-app', app: 'dist' })), ['scaffold/reserved-name']);
    assert.deepEqual(codes(await emitProject(parent, { name: 'my-app', app: '' })), ['scaffold/name']);
    assert.deepEqual(await readdir(parent), []);

    await mkdir(join(parent, 'taken'));
    assert.deepEqual(codes(await emitProject(parent, { name: 'taken' })), ['scaffold/exists']);
    assert.deepEqual(await readdir(join(parent, 'taken')), []);
  });
});

/* ── The component ───────────────────────────────────────────────────────── */

void test('a component is a module and its template, and a stylesheet on request', () => {
  assert.equal(componentClassName('user-card'), 'UserCard');
  assert.equal(componentClassName('x-2d-view'), 'X2dView');

  const plain = componentFiles({ dir: 'web/src/components', tag: 'user-card', styles: false });
  assert.deepEqual([...plain.keys()], ['web/src/components/user-card.js', 'web/src/components/user-card.html']);

  const module = plain.get('web/src/components/user-card.js') ?? '';
  assert.match(module, /^export class UserCard extends SignalElement \{$/mu);
  assert.match(module, /tag: 'user-card',\n {2}element: UserCard,\n {2}module: import\.meta\.url,\n\}\);/u);
  assert.equal(plain.get('web/src/components/user-card.html'), '<p>{{ label }}</p>\n');

  const styled = componentFiles({ dir: 'web/src/components', tag: 'user-card', styles: true });
  assert.deepEqual([...styled.keys()].at(-1), 'web/src/components/user-card.css');
  assert.match(styled.get('web/src/components/user-card.js') ?? '', /module: import\.meta\.url,\n {2}styles: true,\n\}\);/u);
  assert.match(styled.get('web/src/components/user-card.css') ?? '', /^:host \{/u);
});

void test('a component lands in its application, and never over a tag or file that exists', async () => {
  await inTemporary(async (root) => {
    assert.equal(hasErrors(await emitApplication(root, { name: 'web' })), false);
    const app = { name: 'web', dir: join(root, 'web') };

    const card = await emitComponent(root, { app, path: 'user-card' });
    assert.deepEqual(
      card.map((diagnostic) => diagnostic.message),
      ['web/src/components/user-card.js', 'web/src/components/user-card.html'],
    );

    const page = await emitComponent(root, { app, path: 'pages/users-page', styles: true });
    assert.deepEqual(
      page.map((diagnostic) => diagnostic.message),
      ['web/src/pages/users-page.js', 'web/src/pages/users-page.html', 'web/src/pages/users-page.css'],
    );

    for (const path of [undefined, 'card', 'User-card', 'user-', '1-card', 'font-face', 'Pages/x-card', '../x-card']) {
      const refused = codes(await emitComponent(root, { app, path }));
      assert.equal(refused.length, 1, `refused ${JSON.stringify(path)}`);
      assert.match(refused[0] ?? '', /^scaffold\/(?:name|tag)$/u);
    }

    // The application's own tags, and the library's, are taken.
    for (const path of ['user-card', 'shared/user-card', 'home-page', 'ui-avatar']) {
      assert.deepEqual(codes(await emitComponent(root, { app, path })), ['scaffold/tag-taken'], path);
    }

    // A file in the way refuses the whole component, so nothing is half written.
    await writeFile(join(root, 'web', 'src', 'components', 'order-row.html'), '<p>mine</p>\n');
    assert.deepEqual(codes(await emitComponent(root, { app, path: 'order-row' })), ['scaffold/exists']);
    assert.deepEqual((await readdir(join(root, 'web', 'src', 'components'))).sort(), [
      'order-row.html',
      'user-card.html',
      'user-card.js',
    ]);
  });
});
