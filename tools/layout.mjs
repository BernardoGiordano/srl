/**
 * The library's own facts — the mounts, the specifier prefixes, the vendored
 * dependencies, how a URL resolves to a file — belong to the package and live in
 * source/package.json, read by tools/package/interface.mjs. ADR-0033. What is left
 * here is the part a standalone srl checkout would not have:
 *
 *   source/    the library, mounted at /lib/ and /components/. Where the package
 *              happens to sit inside this repository, and nothing more.
 *   <app>/     an application. Any directory in the repository root with an
 *              index.html: example today, more later.
 *
 * Zero dependencies, so it works before `npm install` like the rest of tools/.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MOUNTS } from './package/interface.mjs';

/**
 * The repository these tools operate on.
 *
 * Normally the one they live in: `tools/` sits at its root. `SRL_ROOT` is for the
 * other arrangement — a repository that consumes this checkout rather than
 * containing it, with the library vendored or submoduled somewhere below its root
 * and its own applications beside it. The package finds itself either way
 * (tools/package/interface.mjs); what a consuming repository has to say is where
 * *its* root is, because that is where the applications are.
 */
export const REPO = resolve(
  process.env.SRL_ROOT ?? fileURLToPath(new URL('..', import.meta.url)),
);

/**
 * A repository path as a `/`-separated path relative to the repository root, with
 * no leading slash: `source/lib`.
 *
 * @param {string} path
 * @returns {string}
 */
export function repoPath(path) {
  return relative(REPO, path).split(sep).join('/');
}

/**
 * The library's mounts, expressed as URL rewrites for a server whose root is the
 * repository root rather than one application: `/lib/` -> `/source/lib/`.
 *
 * @web/test-runner serves the repository, so it needs the table in this shape.
 * Where the package sits in the repository is a repository fact, which is why the
 * rewrite is derived here and the mounts themselves are not.
 */
export const LIB_MOUNT_ROUTES = /** @type {Array<[string, string]>} */ (
  MOUNTS.map(([prefix, dir]) => [prefix, `/${repoPath(dir)}/`])
);

/**
 * The mounts as `<source directory> <remote subdirectory>` pairs — `source/lib
 * lib` — one per line.
 *
 * A deploy script needs both halves of each mount and cannot import, so it asks:
 * `node tools/layout.mjs --deploy-pairs`. That is what keeps the deployed tree
 * the shape the import map already assumes.
 *
 * @returns {string}
 */
function deployPairs() {
  return MOUNTS.map(([prefix, dir]) => `${repoPath(dir)} ${prefix.slice(1, -1)}`).join('\n');
}

/** Root directories that are never an application. */
const NOT_APPS = new Set(['source', 'node_modules', 'tools', 'coverage']);

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
export async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every application in the repository, in directory order.
 *
 * Discovered rather than configured: an application *is* a root directory with an
 * index.html, so adding one needs no edit here, and a tool that iterates this
 * cannot silently skip the application somebody added last week.
 *
 * @returns {Promise<Array<{ name: string, dir: string }>>}
 */
export async function apps() {
  /** @type {Array<{ name: string, dir: string }>} */
  const found = [];
  for (const entry of await readdir(REPO, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || NOT_APPS.has(entry.name)) continue;
    const dir = join(REPO, entry.name);
    if (!(await exists(join(dir, 'index.html')))) continue;
    found.push({ name: entry.name, dir });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The application named by `--app`, or by `APP`, or the only one there is.
 *
 * No default name: a tool that falls back to one application silently builds,
 * measures or deploys the wrong thing the day a second one exists. A repository
 * with one application still needs no flag, because with one candidate there is
 * nothing to choose.
 *
 * @returns {Promise<{ name: string, dir: string }>}
 */
export async function selectedApp() {
  const index = process.argv.indexOf('--app');
  const wanted = index === -1 ? process.env.APP : process.argv[index + 1];
  const all = await apps();
  const names = all.map((app) => app.name).join(', ');

  if (wanted === undefined) {
    const [only] = all;
    if (all.length === 1 && only !== undefined) return only;
    throw new Error(
      `Which application? Pass \`--app <name>\` or set APP. Found: ${names || 'none'}.`,
    );
  }

  const match = all.find((app) => app.name === wanted);
  if (match === undefined) {
    throw new Error(`No application "${wanted}" in the repository root. Found: ${names || 'none'}.`);
  }
  return match;
}

/**
 * Files under `dir` matching `pattern`, skipping dependencies and dotfiles.
 *
 * @param {string} dir
 * @param {RegExp} pattern
 * @returns {Promise<string[]>}
 */
export async function walk(dir, pattern) {
  /** @type {string[]} */
  const found = [];
  /** @type {string[]} */
  const queue = [dir];

  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) break;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'vendor') continue;
      if (entry.name.startsWith('.')) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (pattern.test(entry.name)) found.push(full);
    }
  }
  return found;
}

/**
 * @param {string} path
 * @returns {Promise<string>}
 */
export function readText(path) {
  return readFile(path, 'utf8');
}

/* ── As a command ──────────────────────────────────────────────────────────
 *
 * Only for the consumers that are not JavaScript. Guarded, so importing this
 * module stays free of output and exit codes.
 */

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--deploy-pairs')) {
    console.log(deployPairs());
  } else if (process.argv.includes('--apps')) {
    console.log((await apps()).map((app) => app.name).join('\n'));
  } else {
    console.error('usage: node tools/layout.mjs [--deploy-pairs | --apps]');
    process.exit(1);
  }
}
