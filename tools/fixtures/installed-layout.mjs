/**
 * The layout a consumer gets, installed from the tarballs this repository would publish.
 *
 * `@srljs/core` and `@srljs/cli` are real directories under `node_modules`, the
 * project is the working directory, and `@srljs/core/lib/...` is a resolver question
 * rather than a relative path. Nothing in the checkout has that shape, and the difference
 * has broken the build before. ADR-0067, ADR-0068.
 *
 * A consumer starts with `npx @srljs/cli new my-app`, which runs the CLI from npx's own
 * install and writes the project into the working directory. Then `npm install` inside
 * the project installs what the scaffolded `package.json` declares. The fixture does
 * the same in two steps. `launch()` installs the pair into a launcher directory, which
 * stands in for npx's install, and `srl()` with `prefix` runs its bin from there.
 * `install()` then installs the project from its own manifest. ADR-0122.
 *
 * Two callers need it, the packaged-install probe and the editor conformance run, so
 * the packing, installation and local-bin invocation live here. ADR-0098.
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { REPO } from '../../cli/layout.mjs';
import { componentClassName } from '../../cli/scaffold/component.mjs';

const run = promisify(execFile);

const [repositorySource, lockSource, coreSource, cliSource] = await Promise.all(
  [
    readFile(join(REPO, 'package.json'), 'utf8'),
    readFile(join(REPO, 'package-lock.json'), 'utf8'),
    readFile(join(REPO, 'source', 'package.json'), 'utf8'),
    readFile(join(REPO, 'cli', 'package.json'), 'utf8'),
  ],
);
const repositoryPackage = /** @type {Record<string, unknown>} */ (JSON.parse(repositorySource));
const repositoryLock = /** @type {Record<string, unknown>} */ (JSON.parse(lockSource));
const corePackage = /** @type {Record<string, unknown>} */ (JSON.parse(coreSource));
const cliPackage = /** @type {Record<string, unknown>} */ (JSON.parse(cliSource));

/** The framework pair, at the versions in their package manifests. */
const PAIR = Object.freeze({
  '@srljs/core': packageVersion(corePackage, '@srljs/core'),
  '@srljs/cli': packageVersion(cliPackage, '@srljs/cli'),
});

/**
 * Every package a first project declares, at the versions this checkout proves. The
 * application tools come from the root manifest and lockfile, not from the scaffold's
 * own pins, so `install()` catches a scaffold that declares something else. ADR-0098.
 */
const APPLICATION_DEPENDENCIES = Object.freeze({
  ...PAIR,
  '@tailwindcss/cli': developmentVersion(repositoryPackage, '@tailwindcss/cli'),
  '@types/node': lockedVersion(repositoryLock, '@types/node'),
  tailwindcss: developmentVersion(repositoryPackage, 'tailwindcss'),
});

/** @param {Record<string, unknown>} manifest @param {string} name */
function packageVersion(manifest, name) {
  if (typeof manifest.version !== 'string') throw new Error(`${name} has no version.`);
  return manifest.version;
}

/** @param {Record<string, unknown>} manifest @param {string} name */
function developmentVersion(manifest, name) {
  const dependencies = /** @type {Record<string, unknown>} */ (manifest.devDependencies ?? {});
  const version = dependencies[name];
  if (typeof version !== 'string') throw new Error(`The repository declares no ${name}.`);
  return version;
}

/** @param {Record<string, unknown>} lock @param {string} name */
function lockedVersion(lock, name) {
  const packages = /** @type {Record<string, unknown>} */ (lock.packages ?? {});
  const installed = /** @type {Record<string, unknown>} */ (packages[`node_modules/${name}`] ?? {});
  if (typeof installed.version !== 'string') throw new Error(`The lockfile resolves no ${name}.`);
  return installed.version;
}

/**
 * Run an installed bin inside `cwd`, through the local-bin command documented for
 * adopters. Offline mode makes an absent bin a refusal rather than an implicit
 * download. `prefix` names the directory whose install holds the bin, when that is not
 * `cwd`. A non-zero exit is data rather than a throw, because a caller wants to say
 * which step failed and what it printed. ADR-0098.
 *
 * @param {string} cwd
 * @param {string} command
 * @param {string[]} args
 * @param {{ prefix?: string }} [options]
 * @returns {Promise<{ code: number, output: string }>}
 */
export async function localBin(cwd, command, args, options = {}) {
  const prefix = options.prefix === undefined ? [] : ['--prefix', options.prefix];
  try {
    const { stdout, stderr } = await run(
      'npx',
      ['--offline', '--no-install', ...prefix, command, ...args],
      { cwd },
    );
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (cause) {
    const detail = /** @type {{ code?: unknown, stdout?: unknown, stderr?: unknown }} */ (cause);
    return {
      code: typeof detail.code === 'number' ? detail.code : 1,
      output: [detail.stdout, detail.stderr].filter((text) => typeof text === 'string').join(''),
    };
  }
}

/**
 * The toolchain's own bin, which is what most of a probe is made of.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ prefix?: string }} [options]
 * @returns {Promise<{ code: number, output: string }>}
 */
export async function srl(cwd, args, options) {
  return localBin(cwd, 'srl', args, options);
}

/**
 * Pack both workspaces into `destination`, and return the two tarballs.
 *
 * @param {string} destination
 * @returns {Promise<string[]>}
 */
export async function pack(destination) {
  await mkdir(destination, { recursive: true });
  await run(
    'npm',
    ['pack', '--workspace', '@srljs/core', '--workspace', '@srljs/cli', '--pack-destination', destination],
    { cwd: REPO },
  );

  const files = await readdir(destination);
  return ['srljs-core-', 'srljs-cli-'].map((prefix) => {
    const file = files.find((entry) => entry.startsWith(prefix));
    if (file === undefined) throw new Error(`npm pack produced no ${prefix}*.tgz`);
    return join(destination, file);
  });
}

/**
 * Install the pair into `dir` and nothing else, as npx does before it runs
 * `@srljs/cli`. Run its bin with `srl(cwd, args, { prefix: dir })`.
 *
 * @param {string} dir
 * @param {string[]} tarballs from `pack()`
 * @returns {Promise<void>}
 */
export async function launch(dir, tarballs) {
  await mkdir(dir, { recursive: true });
  const manifest = { name: 'launcher', private: true, type: 'module', version: '0.0.0', devDependencies: PAIR };
  await writeFile(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await installTarballs(dir, tarballs, PAIR);
}

/**
 * Install a scaffolded project from its own manifest.
 *
 * The manifest must declare exactly the versions this checkout proves, which is how a
 * scaffold that pins a different version fails here.
 *
 * `npm install` receives the two local tarballs and resolves everything else, preferring
 * npm's cache. No package is linked or copied from this checkout's node_modules, so the
 * root holds the layout a consumer gets rather than a view of this repository.
 *
 * @param {string} root
 * @param {string[]} tarballs from `pack()`
 * @returns {Promise<void>}
 */
export async function install(root, tarballs) {
  await installTarballs(root, tarballs, APPLICATION_DEPENDENCIES);
}

/**
 * The install cannot be `--offline`. The root carries no lockfile, so npm resolves every
 * declared name against a registry packument, and `npm ci` installs from resolved URLs
 * without ever fetching one. A CI runner therefore has the tarballs cached and no
 * packument to resolve them by.
 *
 * @param {string} root
 * @param {string[]} tarballs
 * @param {Readonly<Record<string, string>>} expected
 * @returns {Promise<void>}
 */
async function installTarballs(root, tarballs, expected) {
  const manifest = /** @type {{ dependencies?: Record<string, string>, devDependencies?: Record<string, string> }} */ (
    JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  );
  const declared = { ...manifest.dependencies, ...manifest.devDependencies };
  for (const [name, version] of Object.entries(expected)) {
    if (declared[name] !== version) {
      throw new Error(
        `${join(root, 'package.json')} must declare ${name}@${version}; found ${String(declared[name])}.`,
      );
    }
  }

  await run(
    'npm',
    ['install', '--prefer-offline', '--no-save', '--no-audit', '--no-fund', ...tarballs],
    { cwd: root },
  );
}

/**
 * Put a generated component on the scaffolded home page, as a developer does after
 * `srl generate component <tag>`: the tag in the template, the class in `uses`.
 *
 * Throws when the page no longer has the lines this edits, so a changed scaffold fails
 * here rather than leaving the component unused.
 *
 * @param {string} root the project
 * @param {string} app
 * @param {string} tag a component generated into `<app>/src/components/`
 * @returns {Promise<void>}
 */
export async function useComponent(root, app, tag) {
  const name = componentClassName(tag);
  const page = join(root, app, 'src', 'pages', 'home-page');

  const template = `${page}.html`;
  await writeFile(template, `${(await readFile(template, 'utf8')).trimEnd()}\n<${tag} label="${tag}"></${tag}>\n`);

  const module = `${page}.js`;
  const source = await readFile(module, 'utf8');
  const anchors = /** @type {Array<[string, string]>} */ ([
    [
      "import { t } from '@core/localization/i18n.js';\n",
      `import { t } from '@core/localization/i18n.js';\n\nimport { ${name} } from '../components/${tag}.js';\n`,
    ],
    ['  module: import.meta.url,\n});', `  module: import.meta.url,\n  uses: [${name}],\n});`],
  ]);
  let edited = source;
  for (const [anchor, replacement] of anchors) {
    if (!edited.includes(anchor)) throw new Error(`${module} has no ${JSON.stringify(anchor)} to edit.`);
    edited = edited.replace(anchor, replacement);
  }
  await writeFile(module, edited);
}
