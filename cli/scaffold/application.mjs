/**
 * The shape of an srl application, as a module.
 *
 *   srl generate app <name>        add one to the current project
 *   srl new <project>              write one inside a new project (./project.mjs)
 *
 * The application boots the way a real one does. `main.js` calls `startApplication`,
 * which fetches the manifest and loads the locale bundle, and the root element attaches
 * the router, which loads the home page as its own chunk. Every file written here is
 * read by the page, the build or a check.
 *
 * Every file is also a contract this toolchain enforces after the fact. The document
 * carries the eight facts the production HTML transform requires (ADR-0041). Its import
 * map carries the library's published fragment entry for entry and hash for hash, or
 * the page is blank. The manifest must pass the library's own admission policy. The
 * stylesheet reaches into the installed package by node_modules path. The build needs
 * at least two JavaScript chunks. The tsconfig extends the published base so `@core/`
 * resolves for tsc. ADR-0073, ADR-0122.
 *
 * Two halves.
 *
 *   `applicationFiles(facts)`   pure. Path to contents, so a test can assert the shape
 *                              without a build, a temp directory or a subprocess.
 *   `emitApplication(root, …)`  the adapter. It finds the facts in the installed
 *                              library, refuses to overwrite, and writes.
 *
 * The facts are found rather than typed. The import map is the fragment the library
 * ships, the integrity hash is computed from the bytes in the package, and the mount
 * URLs come from the library's own manifest through cli/package/interface.mjs.
 */

import { join, relative, sep } from 'node:path';

import { error, warning } from '../diagnostics/index.mjs';
import { exists, readText } from '../layout.mjs';
import {
  COMPONENTS,
  IMPORT_MAP_FILE,
  PACKAGE,
  VENDOR,
  fileToUrl,
  subresourceIntegrity,
} from '../package/interface.mjs';
import { applicationNameProblem, writeFiles } from './files.mjs';

/** @import { Diagnostic } from '../diagnostics/types.js' */

/**
 * What the files below are written from. Everything that depends on where the library
 * is installed is resolved once, here.
 *
 * @typedef {object} ApplicationFacts
 * @property {string} name the application's directory name
 * @property {string} importMap the library's import-map fragment, as a consumer pastes it
 * @property {string} tailwindUrl the browser Tailwind build, at the URL a mount serves it
 * @property {string} tailwindIntegrity its sha384, from the bytes in the package
 * @property {string[]} stylesheetUrls the collection stylesheets, as the document links them
 * @property {string[]} stylesheetPaths the same files, as `<name>/src/app.css` imports them
 */

/** The stylesheets the collection publishes, in cascade order. */
const STYLESHEETS = ['style.css', 'theme-default.css'];

/**
 * The application, as paths relative to the project root and the bytes at each.
 *
 * @param {ApplicationFacts} facts
 * @returns {Map<string, string>}
 */
export function applicationFiles(facts) {
  const { name } = facts;
  const app = /** @param {string} path @returns {string} */ (path) => `${name}/${path}`;

  /*
   * The production HTML transform requires exactly one of each of these: the two
   * collection stylesheets, the import map, the browser Tailwind and its inline input,
   * the entry module, the root element and the noscript. ADR-0041.
   *
   * The map is the library's own, pasted, so no specifier or hash here can drift from
   * it. The Tailwind build is a classic script, so its hash is an attribute, and
   * `srl check importmap` requires one.
   */
  const index = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${name}</title>
${facts.stylesheetUrls.map((url) => `    <link rel="stylesheet" href="${url}" />`).join('\n')}
    <script type="importmap">
${facts.importMap.trimEnd()}
    </script>
    <script src="${facts.tailwindUrl}" integrity="${facts.tailwindIntegrity}"></script>
    <style type="text/tailwindcss">
      @custom-variant dark ([data-theme='dark'] &);
    </style>
    <script type="module" src="/src/main.js"></script>
  </head>
  <body>
    <app-root></app-root>
    <noscript>This application needs JavaScript.</noscript>
  </body>
</html>
`;

  const main = `import { startApplication } from '@core/application/runtime.js';

// The library runs startup in a fixed order: manifest, templates, locale, providers,
// then the root. Add \`configure\`, \`providers\` or \`ready\` here as the application
// needs a theme, services or a session. See docs/guide/startup.md in @srljs/core.
await startApplication({
  root: { load: () => import('./app-root.js').then((m) => m.AppRoot) },
});
`;

  const root = `import { defineComponent } from '@core/elements/component.js';
import { SignalElement } from '@core/elements/signal-element.js';
import { attachRouter } from '@core/navigation/router.js';

import { routes } from './routes.js';

// The router renders the active route into the <main> of this element's template.
export class AppRoot extends SignalElement {
  onMount() {
    void attachRouter(this, routes);
  }
}

await defineComponent({ tag: 'app-root', element: AppRoot, module: import.meta.url });
`;

  const routes = `/** @import { RouteDef } from '@core/navigation/types.js' */

/**
 * The route table. The first match wins, and each \`load\` makes its page a chunk of
 * its own. See docs/guide/routing.md in @srljs/core.
 *
 * @type {RouteDef[]}
 */
export const routes = [
  { path: '', load: () => import('./pages/home-page.js').then((m) => m.HomePage) },
];
`;

  const home = `import { defineComponent } from '@core/elements/component.js';
import { SignalElement } from '@core/elements/signal-element.js';
import { signal } from '@core/foundation/reactive.js';
import { t } from '@core/localization/i18n.js';

export class HomePage extends SignalElement {
  #count = signal(0);

  get heading() {
    return t('home.title');
  }

  get count() {
    return this.#count.value;
  }

  increment() {
    this.#count.value += 1;
  }
}

await defineComponent({
  tag: 'home-page',
  element: HomePage,
  module: import.meta.url,
});
`;

  const homeTemplate = `<h1 class="text-2xl font-semibold">{{ heading }}</h1>
<p class="mt-2">{{ t('home.intro') }}</p>
<button type="button" (click)="increment()" class="mt-4 rounded border px-3 py-1">{{ count }}</button>
`;

  const messages = {
    home: {
      title: name,
      intro: `Edit ${name}/src/pages/home-page.html and this page updates.`,
    },
  };

  /*
   * The build compiles this with the project's Tailwind CLI. It reaches into the
   * installed package by node_modules path, and a wrong path is a Tailwind resolve
   * error rather than anything the build reports.
   */
  const css = `${facts.stylesheetPaths.map((path) => `@import '${path}';`).join('\n')}
@import 'tailwindcss' source(none);

@source '../src/**/*.js';
@source '../src/**/*.html';
@source '../index.html';
`;

  /*
   * The three required top-level sections, each at its smallest admissible value. That
   * is one locale with one bundle, and no remotes. The library's own admission policy
   * checks this at startup. ADR-0010.
   */
  const manifest = {
    auth: { apiBaseUrl: '/api' },
    i18n: { defaultLocale: 'en', supportedLocales: ['en'], bundles: ['/i18n/{locale}.json'] },
    remotes: [],
  };

  // Extended, never copied, so `@core/` resolves for tsc from one table. ADR-0068.
  const tsconfig = {
    extends: '@srljs/core/tsconfig.base.json',
    compilerOptions: { types: ['node'] },
    include: [`${name}/**/*.js`],
  };

  return new Map([
    [app('index.html'), index],
    [app('app.manifest.json'), json(manifest)],
    [app('i18n/en.json'), json(messages)],
    [app('src/main.js'), main],
    [app('src/app-root.js'), root],
    [app('src/app-root.html'), `<main class="mx-auto max-w-2xl p-8"></main>\n`],
    [app('src/routes.js'), routes],
    [app('src/pages/home-page.js'), home],
    [app('src/pages/home-page.html'), homeTemplate],
    [app('src/app.css'), css],
    ['tsconfig.json', json(tsconfig)],
  ]);
}

/** @param {unknown} value @returns {string} */
function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * The facts, found in the installed library.
 *
 * `library` is where the project will serve the library from. It is the installed
 * package when adding to an existing project. A new project has not installed anything
 * yet, so its caller passes the project's own `node_modules/@srljs/core`.
 *
 * @param {string} root the project the application is created in
 * @param {string} name
 * @param {string} [library]
 * @returns {Promise<ApplicationFacts>}
 */
export async function applicationFacts(root, name, library = PACKAGE) {
  const src = join(root, name, 'src');
  const tailwind = join(VENDOR, 'tailwind-browser.js');
  const tailwindUrl = fileToUrl(root, tailwind);

  if (tailwindUrl === null) {
    throw new Error(
      `The library's ${tailwind} is under no mount the manifest declares, so no URL serves it.`,
    );
  }

  return {
    name,
    importMap: await readText(IMPORT_MAP_FILE),
    tailwindUrl,
    tailwindIntegrity: await subresourceIntegrity(tailwind),
    stylesheetUrls: STYLESHEETS.map((file) => {
      const url = fileToUrl(root, join(COMPONENTS, file));
      if (url === null) {
        throw new Error(`The collection's ${file} is under no mount the manifest declares.`);
      }
      return url;
    }),
    stylesheetPaths: STYLESHEETS.map((file) => {
      const installed = join(library, relative(PACKAGE, join(COMPONENTS, file)));
      return relative(src, installed).split(sep).join('/');
    }),
  };
}

/**
 * Write a new application into a project, and say what was written.
 *
 * An existing application directory is refused whole, even an empty one, because a
 * merge would leave a shape nobody described. `tsconfig.json` may already exist for a
 * good reason, since a project adding its second application has one, so an existing
 * copy is kept and reported.
 *
 * @param {string} root the project root
 * @param {{ name?: string, library?: string }} [options]
 * @returns {Promise<Diagnostic[]>}
 */
export async function emitApplication(root, options = {}) {
  const refused = applicationNameProblem(options.name, 'srl generate app admin');
  if (refused !== null) return [refused];
  const name = /** @type {string} */ (options.name);

  const dir = join(root, name);
  if (await exists(dir)) {
    return [
      error(
        'scaffold/exists',
        'already exists. Move it aside or pick another name, because a scaffold merged ' +
          'into it would leave a shape nobody described.',
        { file: dir, group: name },
      ),
    ];
  }

  const files = applicationFiles(await applicationFacts(root, name, options.library));
  return writeFiles(root, files, {
    group: name,
    keep: new Map([
      [
        'tsconfig.json',
        (file) =>
          warning(
            'scaffold/tsconfig-kept',
            `already exists and was left alone. Add "${name}/**/*.js" to its \`include\` so ` +
              `\`srl check\` covers the new application.`,
            { file, group: name },
          ),
      ],
    ]),
  });
}
