/**
 * A new srl project: the package manifest, the ignore file, the agent notes and one
 * application.
 *
 *   srl new <project> [--app <name>] [--json]
 *
 * Run through `npx @srljs/cli new my-app`, this is the whole setup. It writes
 * `my-app/` with a `package.json` that pins the matching `@srljs/core` and
 * `@srljs/cli`, the application-owned build tools and the scripts, then an application
 * at `my-app/web/` through ./application.mjs. It does not install or run Git, so it
 * works offline and with any package manager. ADR-0122.
 *
 *   `projectFiles(facts)`       pure. Path to contents.
 *   `emitProject(parent, …)`   the adapter. It finds the facts, refuses an existing
 *                              directory, and writes.
 */

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { error, outputFormat, report } from '../diagnostics/index.mjs';
import { exists } from '../layout.mjs';
import { MANIFEST } from '../package/interface.mjs';
import { applicationFacts, applicationFiles } from './application.mjs';
import { NAME, applicationNameProblem, writeFiles } from './files.mjs';

/** @import { Diagnostic } from '../diagnostics/types.js' */
/** @import { ApplicationFacts } from './application.mjs' */

/**
 * @typedef {object} ProjectFacts
 * @property {string} name the project's directory and package name
 * @property {string} core the `@srljs/core` version the application was written from
 * @property {string} cli the `@srljs/cli` version writing it
 * @property {Readonly<Record<string, string>>} tools the application-owned build and
 *   type packages this toolchain release was checked with
 * @property {ApplicationFacts} app
 */

/** The application a new project starts with, unless `--app` names another. */
export const DEFAULT_APP = 'web';

/**
 * The project, as paths relative to its root and the bytes at each.
 *
 * @param {ProjectFacts} facts
 * @returns {Map<string, string>}
 */
export function projectFiles(facts) {
  const app = facts.app.name;

  /*
   * The two srl packages are an exact pair, because the CLI checks templates and
   * manifests against the runtime dialect of one core version. ADR-0067. Tailwind and
   * the Node types belong to the application, so they are pinned here rather than
   * installed by the CLI. ADR-0098.
   */
  const manifest = {
    name: facts.name,
    private: true,
    type: 'module',
    version: '0.0.0',
    engines: { node: '>=22' },
    scripts: {
      dev: `srl serve --app ${app}`,
      check: 'srl check',
      build: `srl build --app ${app}`,
    },
    dependencies: { '@srljs/core': facts.core },
    devDependencies: sorted({ '@srljs/cli': facts.cli, ...facts.tools }),
  };

  const ignore = `node_modules/
dist/
`;

  const agents = `# Agent notes

\`${app}/\` is an srl application. The browser loads its files as written, through the
import map in \`${app}/index.html\`. Development has no compile step.

## Verify every change

Run \`npx --no-install srl check --json\` after each edit, and fix every finding whose
\`severity\` is \`error\`. Each finding has a stable \`code\`, a \`file\` and a position.
\`npx --no-install srl check --codes\` explains every code.

## Commands

| Command | Use |
|---|---|
| \`npm run dev\` | Serve \`${app}/\` with live updates. |
| \`npm run check\` | Check types, templates, the import map, messages and the project model. |
| \`npm run build\` | Build the production artifact into \`dist/${app}/\`. Needs a Git commit. |
| \`npx --no-install srl generate component <tag>\` | Add a component and its template under \`${app}/src/components/\`. |
| \`npx --no-install srl generate app <name>\` | Add another application. |

## Rules

- A component is a module with a sibling \`.html\` template. A template that names
  another component lists that component's class in \`uses\`.
- Leave the import map in \`${app}/index.html\` as written. \`srl check importmap\`
  compares it with the installed library.
- Message keys live in \`${app}/i18n/en.json\`. \`npx --no-install srl check messages --write\`
  adds the missing ones.
- \`@srljs/core\` and \`@srljs/cli\` stay pinned to the same exact version.

## Documentation

The installed packages carry the documentation for their version.

- \`node_modules/@srljs/core/llms.txt\` indexes the guides, references and decision
  records.
- \`node_modules/@srljs/core/docs/reference/template-dialect.md\` describes the template
  syntax.
- \`node_modules/@srljs/cli/docs/reference/diagnostic-codes.md\` explains every check code.
- A comment that cites \`ADR-0072\` refers to
  \`node_modules/@srljs/core/docs/adr/0072-*.md\`.
`;

  return new Map([
    ['package.json', `${JSON.stringify(manifest, null, 2)}\n`],
    ['.gitignore', ignore],
    ['AGENTS.md', agents],
    ...applicationFiles(facts.app),
  ]);
}

/**
 * @param {Record<string, string>} record
 * @returns {Record<string, string>}
 */
function sorted(record) {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * The versions a new project pins, read from the CLI's own manifest and the library
 * whose import map the application pastes.
 *
 * @returns {Promise<Pick<ProjectFacts, 'core' | 'cli' | 'tools'>>}
 */
async function versions() {
  const own = /** @type {{ version: string, scaffold?: { devDependencies?: Record<string, string> } }} */ (
    JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  );
  return {
    core: String(MANIFEST.version),
    cli: own.version,
    tools: own.scaffold?.devDependencies ?? {},
  };
}

/**
 * Write a new project into `parent`, and say what was written.
 *
 * The project directory must not exist, so nothing the developer owns is touched.
 *
 * @param {string} parent the directory the project is created in
 * @param {{ name?: string, app?: string }} [options]
 * @returns {Promise<Diagnostic[]>}
 */
export async function emitProject(parent, options = {}) {
  const { name } = options;
  if (name === undefined || !NAME.test(name)) {
    return [
      error(
        'scaffold/name',
        `${name === undefined ? 'No name given' : `"${name}" is not a name`}. A project is a ` +
          `new directory and a package name, so its name is one lowercase kebab-case segment: ` +
          `\`srl new my-app\`.`,
      ),
    ];
  }

  const app = options.app ?? DEFAULT_APP;
  const refused = applicationNameProblem(app, `srl new ${name} --app ${DEFAULT_APP}`);
  if (refused !== null) return [refused];

  const dir = join(parent, name);
  if (await exists(dir)) {
    return [
      error('scaffold/exists', 'already exists. Pick another name or remove it first.', {
        file: dir,
        group: name,
      }),
    ];
  }

  // Nothing is installed yet. The application reaches the library where the project's
  // own install will put it.
  const library = join(dir, 'node_modules', '@srljs', 'core');
  const facts = { name, ...(await versions()), app: await applicationFacts(dir, app, library) };
  return writeFiles(dir, projectFiles(facts), { group: name });
}

/* ── As a command ──────────────────────────────────────────────────────────
 *
 * Guarded, so importing this module stays free of output and exit codes.
 */

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  const flag = args.indexOf('--app');
  const app = flag === -1 ? undefined : (args[flag + 1] ?? '');
  const name = args.find(
    (argument, index) => !argument.startsWith('-') && (flag === -1 || index !== flag + 1),
  );
  const project = name ?? '<project>';
  process.exit(
    report(await emitProject(process.cwd(), { name, app }), {
      format: outputFormat(),
      summary: [
        `A project in ${project}/. Next:`,
        '',
        `  cd ${project}`,
        '  npm install',
        '  npm run dev',
        '',
        '`npm run check` runs every check. Commit before the first `npm run build`,',
        'because the artifact records the commit it was built from.',
      ].join('\n'),
    }),
  );
}
