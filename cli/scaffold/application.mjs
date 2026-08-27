/**
 * The shape of an srl application, as a module.
 *
 *   node cli/scaffold/application.mjs <name>        (or: srl new <name>)
 *
 * Nine interdependent files, and every one of them is a contract this toolchain
 * enforces after the fact: the eight facts the production HTML transform requires of
 * the document (ADR-0041), an import map that must carry the library's published
 * fragment entry for entry and hash for hash or the page is blank, a manifest the
 * library's own admission policy has to admit, a stylesheet that reaches into the
 * installed package by node_modules path, at least two JavaScript chunks because an
 * application with nothing behind an `import()` carries every route in its entry, and
 * a tsconfig extending the published base so `@core/` resolves for tsc.
 *
 * Getting any one of them wrong is a blank page or a refused build, which is why
 * `srl check importmap` exists. Until this module, the only executable description of
 * a correct application was the fixture inside tools/checks/pack-check.mjs — reachable
 * by `npm run pack:check` and by nothing else — and an adopter re-derived the same nine
 * files from prose. ADR-0073.
 *
 * Two halves, deliberately:
 *
 *   `applicationFiles(facts)`   pure. Path -> contents, and nothing touches disk, so
 *                              what a scaffolded document contains is assertable
 *                              without a build, a temp directory or a subprocess.
 *   `emitApplication(root, …)`  the adapter. It finds the facts in the installed
 *                              library, refuses to overwrite, and writes.
 *
 * The facts are found, never typed: the import map is the fragment the library ships,
 * the integrity hash is computed from the bytes in the package, and the mount URLs and
 * the node_modules path to the collection stylesheets are derived from the library's own
 * manifest through cli/package/interface.mjs. Nothing in here can go stale against the
 * library it scaffolds against.
 *
 * Findings are values, printed by cli/diagnostics/index.mjs like every other command's.
 * ADR-0072.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { error, info, outputFormat, report, warning } from '../diagnostics/index.mjs';
import { NOT_APPS, REPO, exists, readText } from '../layout.mjs';
import {
  COMPONENTS,
  IMPORT_MAP_FILE,
  VENDOR,
  fileToUrl,
  subresourceIntegrity,
} from '../package/interface.mjs';

/** @import { Diagnostic } from '../diagnostics/types.js' */

/**
 * What the files below are written from: everything that depends on where the library
 * is installed, resolved once.
 *
 * @typedef {object} ApplicationFacts
 * @property {string} name the application's directory name, and its title
 * @property {string} importMap the library's import-map fragment, as a consumer pastes it
 * @property {string} tailwindUrl the browser Tailwind build, at the URL a mount serves it
 * @property {string} tailwindIntegrity its sha384, from the bytes in the package
 * @property {string[]} stylesheetUrls the collection stylesheets, as the document links them
 * @property {string[]} stylesheetPaths the same files, as `<name>/src/app.css` imports them
 */

/** The stylesheets the collection publishes, in cascade order. */
const STYLESHEETS = ['style.css', 'theme-default.css'];

/** A name that is a directory, an application and nothing else. */
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/**
 * The application, as paths relative to the repository root and the bytes at each.
 *
 * Pure: every fact that varies is in `facts`, so this function is the whole answer to
 * "what is a correct srl application" and a test can read it without installing one.
 *
 * @param {ApplicationFacts} facts
 * @returns {Map<string, string>}
 */
export function applicationFiles(facts) {
  const { name } = facts;
  const app = /** @param {string} path @returns {string} */ (path) => `${name}/${path}`;

  /**
   * Eight facts, exactly one of each, and the production HTML transform refuses the
   * document otherwise: the two collection stylesheets it replaces with the compiled
   * one, the import map it replaces with pinned chunk URLs, the browser Tailwind and its
   * inline input it replaces with the compiled sheet, the entry module, the root element
   * and the noscript. ADR-0041. That contract is the reason this is a whole index.html
   * rather than a stub.
   *
   * The map is the library's own, pasted. It is what a consumer does by hand, and it
   * means no specifier and no integrity hash written here can drift from the library.
   * The Tailwind build is a classic script, so its hash is an attribute rather than an
   * integrity-map entry, and `srl check importmap` requires one on anything vendored.
   */
  const index = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
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

  /*
   * A component, a template and a signal: the three things whose types the template
   * checker resolves through the library wherever it was installed.
   *
   * Two modules, and the second is reached by `import()`, because the build refuses an
   * artifact with fewer than two JavaScript chunks. The lazy chunk is also where a
   * second copy of the framework would show up if the library resolved twice.
   */
  const main = `import { defineComponent } from '@core/elements/component.js';
import { SignalElement } from '@core/elements/signal-element.js';
import { signal } from '@core/foundation/reactive.js';

// The smallest thing that runs. An application with routes, a manifest-driven startup
// and a session replaces this with one call to \`startHostedApplication\` from
// \`@host/runtime.js\`; everything else in this directory stays as it is.
export class AppRoot extends SignalElement {
  #count = signal(0);

  get count() {
    return this.#count.value;
  }

  increment() {
    this.#count.value += 1;
  }

  async open() {
    await import('./detail.js');
  }
}

await defineComponent({
  tag: 'app-root',
  element: AppRoot,
  module: import.meta.url,
});
`;

  const detail = `import { defineComponent } from '@core/elements/component.js';
import { SignalElement } from '@core/elements/signal-element.js';

export class AppDetail extends SignalElement {
  get title() {
    return 'detail';
  }
}

await defineComponent({
  tag: 'app-detail',
  element: AppDetail,
  module: import.meta.url,
});
`;

  /*
   * Reaching into the package by node_modules path is what an application's own
   * stylesheet does, and getting it wrong is a Tailwind resolve error rather than
   * anything the build would otherwise catch. `npm run css` compiles this to
   * `<name>/app.css`, which is what the production document links.
   */
  const css = `${facts.stylesheetPaths.map((path) => `@import '${path}';`).join('\n')}
@import 'tailwindcss' source(none);

@source '../src/**/*.js';
@source '../src/**/*.html';
@source '../index.html';
`;

  /*
   * The three frozen top-level fields, at their smallest admissible values: one locale
   * with one bundle, no remotes. The policy that admits this is the library's own — the
   * same module the browser runs at startup — so a shape it would refuse fails in a
   * check rather than in a page. ADR-0010.
   */
  const manifest = {
    auth: { apiBaseUrl: '/api' },
    i18n: { defaultLocale: 'en', supportedLocales: ['en'], bundles: ['/i18n/{locale}.json'] },
    remotes: [],
  };

  /*
   * Extending the published base is the documented setup and the only thing that makes
   * `@core/` resolve for tsc. Four path mappings copied here instead would be a second
   * table, free to drift from the import map. ADR-0068.
   */
  const tsconfig = {
    extends: '@srljs/core/tsconfig.base.json',
    compilerOptions: { types: ['node'] },
    include: [`${name}/**/*.js`],
  };

  // Two bindings and two event handlers, which is what makes this a template the
  // checker has to resolve against the class beside it rather than static markup.
  const mainTemplate = `<button type="button" (click)="increment()" class="font-semibold">{{ count }}</button>
<button type="button" (click)="open()">open</button>
`;

  return new Map([
    [app('index.html'), index],
    [app('src/main.js'), main],
    [app('src/main.html'), mainTemplate],
    [app('src/detail.js'), detail],
    [app('src/detail.html'), `<h1>{{ title }}</h1>\n`],
    [app('src/app.css'), css],
    [app('i18n/en.json'), `${JSON.stringify({}, null, 2)}\n`],
    [app('app.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`],
    ['tsconfig.json', `${JSON.stringify(tsconfig, null, 2)}\n`],
  ]);
}

/**
 * The facts, found in the library as installed.
 *
 * @param {string} root the repository the application is being created in
 * @param {string} name
 * @returns {Promise<ApplicationFacts>}
 */
async function facts(root, name) {
  const src = join(root, name, 'src');
  const tailwind = join(VENDOR, 'tailwind-browser.js');
  const tailwindUrl = fileToUrl(root, tailwind);

  if (tailwindUrl === null) {
    throw new Error(
      `The library's ${tailwind} is under no mount the manifest declares, so no URL serves it. ` +
        `A document cannot reference what a browser cannot fetch.`,
    );
  }

  /** @param {string} file @returns {string} */
  const asImport = (file) => `${relative(src, file).split(sep).join('/')}`;

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
    stylesheetPaths: STYLESHEETS.map((file) => asImport(join(COMPONENTS, file))),
  };
}

/**
 * Write a new application into a repository, and say what was written.
 *
 * Refuses rather than overwrites. The directory is refused whole, because a scaffold
 * that merged into an existing application would leave a repository in a state neither
 * this module nor its author described. `tsconfig.json` is the one file that may already
 * exist for a good reason — a repository adding its second application has one — so it
 * is reported rather than replaced.
 *
 * @param {string} root the repository root
 * @param {{ name?: string }} [options]
 * @returns {Promise<Diagnostic[]>}
 */
export async function emitApplication(root, options = {}) {
  const name = options.name;

  if (name === undefined || !NAME.test(name)) {
    return [
      error(
        'new/name',
        `${name === undefined ? 'No name given' : `"${name}" is not a name`}. An application ` +
          `is a directory in the repository root, so its name is one lowercase kebab-case ` +
          `segment: \`srl new web\`.`,
      ),
    ];
  }

  if (NOT_APPS.has(name)) {
    return [
      error(
        'new/reserved-name',
        `"${name}" is a directory the toolchain never reads as an application, so nothing would ` +
          `ever build what was written there. Reserved: ${[...NOT_APPS].sort().join(', ')}.`,
      ),
    ];
  }

  const dir = join(root, name);
  if (await exists(dir)) {
    return [
      error(
        'new/exists',
        `already exists. A scaffold that merged into it would leave a repository in a shape ` +
          `neither this command nor you described; move it aside or pick another name.`,
        { file: dir, group: name },
      ),
    ];
  }

  const files = applicationFiles(await facts(root, name));

  /** @type {Diagnostic[]} */
  const found = [];
  for (const [path, contents] of files) {
    const file = join(root, path);

    if (path === 'tsconfig.json' && (await exists(file))) {
      found.push(
        warning(
          'new/tsconfig-kept',
          `already exists and was left alone. Add "${name}/**/*.js" to its \`include\` so ` +
            `\`srl check templates\` covers the new application.`,
          { file, group: name },
        ),
      );
      continue;
    }

    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, contents);
    found.push(info('new/wrote', path, { group: name }));
  }

  return found;
}

/* ── As a command ──────────────────────────────────────────────────────────
 *
 * Guarded, so importing this module stays free of output and exit codes.
 */

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const name = process.argv.slice(2).find((argument) => !argument.startsWith('-'));
  const app = name ?? '<name>';
  process.exit(
    report(await emitApplication(REPO, { name }), {
      format: outputFormat(),
      summary:
        `An application. \`srl serve --app ${app}\` runs it, and ` +
        `\`tailwindcss -i ${app}/src/app.css -o ${app}/app.css\` compiles its stylesheet.`,
    }),
  );
}
