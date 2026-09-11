/**
 * The layout a consumer gets, installed from the tarballs this repository would publish.
 *
 * `@srljs/core` and `@srljs/cli` are real directories under `node_modules`, the
 * repository is the working directory, and `@srljs/core/lib/...` is a resolver question
 * rather than a relative path. Nothing in the checkout has that shape, and the difference
 * has broken the build before. ADR-0067, ADR-0068.
 *
 * Two callers need it now — the packaged-install probe and the editor conformance run —
 * so the package manifest, installation and local-bin invocation live here rather than
 * in whichever adapter wrote them first. ADR-0098.
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { REPO } from '../../cli/layout.mjs';

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

/**
 * The dependencies a first application declares, at the versions this checkout proves.
 * The framework pair comes from its package manifests; application tools come from the
 * root manifest and lockfile. A fixture that copied this table would be free to omit the
 * next prerequisite the build gains. ADR-0098.
 */
const APPLICATION_DEV_DEPENDENCIES = Object.freeze({
  '@srljs/core': packageVersion(corePackage, '@srljs/core'),
  '@srljs/cli': packageVersion(cliPackage, '@srljs/cli'),
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
 * The package manifest shared by every installed application fixture.
 *
 * @param {string} name
 * @returns {string}
 */
export function applicationManifest(name) {
  return `${JSON.stringify(
    {
      name,
      private: true,
      type: 'module',
      version: '0.0.0',
      devDependencies: APPLICATION_DEV_DEPENDENCIES,
    },
    null,
    2,
  )}\n`;
}

/**
 * Run one of the installed packages' bins inside `root`, through the local-bin command
 * documented for adopters. Offline mode makes an absent local bin a refusal rather than
 * an implicit download. A non-zero exit is data, not a throw: a caller wants to say which
 * step failed and what it printed. ADR-0098.
 *
 * @param {string} root
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<{ code: number, output: string }>}
 */
export async function localBin(root, command, args) {
  try {
    const { stdout, stderr } = await run('npx', ['--offline', '--no-install', command, ...args], {
      cwd: root,
    });
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
 * @param {string} root
 * @param {string[]} args
 * @returns {Promise<{ code: number, output: string }>}
 */
export async function srl(root, args) {
  return localBin(root, 'srl', args);
}

/**
 * Pack both workspaces and install the application's declared dependencies.
 *
 * `npm install` receives the two local tarballs and resolves everything else, preferring
 * npm's cache. No package is linked or copied from this checkout's node_modules, so the
 * root holds the layout a consumer gets rather than a view of this repository.
 *
 * The install cannot be `--offline`. This root carries no lockfile, so npm resolves every
 * declared name against a registry packument, and `npm ci` installs from resolved URLs
 * without ever fetching one. A CI runner therefore has the tarballs cached and no
 * packument to resolve them by.
 *
 * @param {string} root
 * @returns {Promise<void>}
 */
export async function install(root) {
  const manifest = /** @type {{ dependencies?: Record<string, string>, devDependencies?: Record<string, string> }} */ (
    JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  );
  const declared = { ...manifest.dependencies, ...manifest.devDependencies };
  for (const [name, version] of Object.entries(APPLICATION_DEV_DEPENDENCIES)) {
    if (declared[name] !== version) {
      throw new Error(
        `${join(root, 'package.json')} must declare ${name}@${version}; found ${String(declared[name])}.`,
      );
    }
  }

  const tarballs = join(root, 'tarballs');
  await mkdir(tarballs, { recursive: true });
  await run(
    'npm',
    ['pack', '--workspace', '@srljs/core', '--workspace', '@srljs/cli', '--pack-destination', tarballs],
    { cwd: REPO },
  );

  const files = await readdir(tarballs);
  const packages = ['srljs-core-', 'srljs-cli-'].map((prefix) => {
    const file = files.find((entry) => entry.startsWith(prefix));
    if (file === undefined) throw new Error(`npm pack produced no ${prefix}*.tgz`);
    return join(tarballs, file);
  });

  await run(
    'npm',
    ['install', '--prefer-offline', '--no-save', '--no-audit', '--no-fund', ...packages],
    { cwd: root },
  );
}
