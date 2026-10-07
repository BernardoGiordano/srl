/**
 * The one place build, composition and release write output, and the rules every
 * write obeys. ADR-0132.
 *
 *   within        A path a caller names is relative to a root it owns. It resolves
 *                 inside that root as written, with no `.` or `..` segment to clean.
 *   writeWithin   The write lands inside the root on disk too. A symbolic link in
 *                 the tree can't carry it out.
 *   createWithin  The same write, which also refuses anything already at the path,
 *                 a symbolic link included. `entryWithin` reads what is there first.
 *   admitOutput   A directory is replaced only when a previous build wrote it, which
 *                 its `artifact.json` says, unless the caller forces it. A directory
 *                 that holds the project or the home directory is never replaced.
 *   embedJson     JSON written into an HTML document can't end the element that
 *                 holds it.
 *
 * A release never replaces a directory, so it uses the first two and `listFiles`.
 * A scaffold never replaces a file, so it uses `entryWithin` and `createWithin`.
 */

import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

import { REPO } from '../layout.mjs';
import { REPORT } from './artifact-report.mjs';

/**
 * The absolute path of `path` inside `root`, or a refusal.
 *
 * `path` is `/`-separated, as an inventory records it. An empty, `.` or `..` segment,
 * a leading `/`, a backslash or a NUL is refused rather than cleaned up, because a
 * path that lands inside the root only after normalizing was written to leave it.
 *
 * @param {string} root
 * @param {string} path
 * @returns {string}
 */
export function within(root, path) {
  if (
    typeof path !== 'string' ||
    path === '' ||
    path.startsWith('/') ||
    /[\\\0]/u.test(path) ||
    path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`output: unsafe relative path ${JSON.stringify(path)}`);
  }
  const base = resolve(root);
  const target = resolve(base, path);
  if (!contains(base, target)) {
    throw new Error(`output: ${JSON.stringify(path)} escapes ${base}`);
  }
  return target;
}

/**
 * Write `bytes` to `path` inside `root`.
 *
 * @param {string} root
 * @param {string} path
 * @param {string | Uint8Array} bytes
 */
export async function writeWithin(root, path, bytes) {
  await writeFile(await prepare(root, path), bytes);
}

/**
 * Copy the file at `source` to `path` inside `root`.
 *
 * @param {string} root
 * @param {string} path
 * @param {string} source
 */
export async function copyWithin(root, path, source) {
  await copyFile(source, await prepare(root, path));
}

/**
 * What sits at `path` inside `root`, read without following a symbolic link, or null
 * when nothing does.
 *
 * The path is admitted as a write to it would be, so a parent that leaves the root
 * through a symbolic link is refused before anything is written.
 *
 * @param {string} root
 * @param {string} path
 * @returns {Promise<import('node:fs').Stats | null>}
 */
export async function entryWithin(root, path) {
  return lstatOrNull(await confined(root, path));
}

/**
 * Create the file `path` inside `root` holding `bytes`.
 *
 * The file must not exist. A file, directory or symbolic link already at `path`
 * refuses the write, a dangling link included, so nothing is overwritten and no link
 * carries the bytes elsewhere.
 *
 * @param {string} root
 * @param {string} path
 * @param {string | Uint8Array} bytes
 */
export async function createWithin(root, path, bytes) {
  const target = await confined(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes, { flag: 'wx' });
}

/**
 * Every regular file below `root`, as sorted `/`-separated relative paths.
 *
 * A symbolic link or special file anywhere in the tree is refused, because its bytes
 * belong to whatever it points at. Dot files are listed like any other.
 *
 * @param {string} root
 * @returns {Promise<string[]>}
 */
export async function listFiles(root) {
  /** @type {string[]} */
  const files = [];
  /** @param {string} directory @param {string} prefix */
  const visit = async (directory, prefix) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await visit(join(directory, entry.name), `${path}/`);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`output: ${join(directory, entry.name)} is a symbolic link or special file.`);
    }
  };
  await visit(resolve(root), '');
  return files.sort((left, right) => left.localeCompare(right));
}

/**
 * Admit `outDir` as a directory a build may replace, and return its absolute path.
 *
 * `force` admits a directory a build didn't write. Neither the output nor its
 * `.previous` backup may hold the project or the home directory.
 *
 * @param {string} outDir
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<string>}
 */
export async function admitOutput(outDir, { force = false } = {}) {
  const output = resolve(outDir);
  for (const target of [output, `${output}.previous`]) {
    const physical = await physicalPath(target);
    for (const { name, path } of [
      { name: 'the project', path: REPO },
      { name: 'the home directory', path: homedir() },
    ]) {
      if (contains(physical, await physicalPath(path))) {
        throw new Error(
          `output: ${target} holds ${name}, ${path}, and replacing it would delete ${name}.`,
        );
      }
    }
    await requireReplaceable(target, force);
  }
  return output;
}

/**
 * A private directory beside `output`, so publishing is one rename on one filesystem.
 *
 * @param {string} output
 * @param {string} label
 * @returns {Promise<string>}
 */
export async function stageBeside(output, label) {
  const parent = dirname(output);
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, `.${label}-`));
}

/**
 * Move `stage` into place at `output`.
 *
 * An existing output moves aside until the rename succeeds, so a failed publish keeps
 * the last artifact. `output` is admitted again first, because it may have changed
 * while the build ran.
 *
 * @param {string} stage
 * @param {string} output
 * @param {{ force?: boolean }} [options]
 */
export async function replaceOutput(stage, output, { force = false } = {}) {
  await admitOutput(output, { force });
  const backup = `${output}.previous`;
  const abandonedBackup = await present(backup);
  let hadOutput = await present(output);
  if (abandonedBackup && !hadOutput) {
    await rename(backup, output);
    hadOutput = true;
  } else if (abandonedBackup) {
    await rm(backup, { recursive: true, force: true });
  }
  if (hadOutput) await rename(output, backup);
  try {
    await rename(stage, output);
  } catch (error) {
    if (hadOutput) await rename(backup, output);
    throw new Error(`output: could not atomically replace ${output}`, { cause: error });
  }
  await rm(backup, { recursive: true, force: true });
}

/**
 * JSON as text an HTML parser reads to the end.
 *
 * `<`, `>` and `&` become `\u003c`, `\u003e` and `\u0026`, so no value can close the
 * element that holds it, open a comment or start a character reference. U+2028 and
 * U+2029 are escaped too, for any reader that takes the text as script. `JSON.parse`
 * returns the same value.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function embedJson(value) {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/**
 * The checked target of one write. Its parent resolves inside the root after
 * symbolic links, and the target is a regular file or nothing.
 *
 * @param {string} root
 * @param {string} path
 */
async function prepare(root, path) {
  const target = await confined(root, path);
  await mkdir(dirname(target), { recursive: true });
  const existing = await lstatOrNull(target);
  if (existing !== null && !existing.isFile()) {
    throw new Error(`output: ${JSON.stringify(path)} in ${root} is not a regular file.`);
  }
  return target;
}

/**
 * The absolute path of `path` inside `root`, whose parent resolves inside the root
 * after symbolic links.
 *
 * @param {string} root
 * @param {string} path
 * @returns {Promise<string>}
 */
async function confined(root, path) {
  const target = within(root, path);
  if (!contains(await physicalPath(root), await physicalPath(dirname(target)))) {
    throw new Error(`output: ${JSON.stringify(path)} leaves ${root} through a symbolic link.`);
  }
  return target;
}

/**
 * Refuse to replace `path` unless a build wrote it, it is empty, it is absent, or the
 * caller forces it.
 *
 * @param {string} path
 * @param {boolean} force
 */
async function requireReplaceable(path, force) {
  const entry = await lstatOrNull(path);
  if (entry === null || force) return;
  if (entry.isDirectory()) {
    if ((await readdir(path)).length === 0) return;
    if ((await lstatOrNull(join(path, REPORT)))?.isFile() === true) return;
  }
  throw new Error(
    `output: ${path} exists and holds no ${REPORT}, so no build wrote it, and replacing ` +
      `it would delete what it holds. Name a new or empty directory, or pass --force.`,
  );
}

/**
 * `path` with every symbolic link in its existing part resolved. The part that
 * doesn't exist yet is appended as written.
 *
 * A dangling link resolves to where it points, because a directory created through it
 * would land there.
 *
 * @param {string} path
 * @returns {Promise<string>}
 */
async function physicalPath(path) {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (cause) {
    if (/** @type {NodeJS.ErrnoException} */ (cause).code !== 'ENOENT') throw cause;
    const parent = dirname(absolute);
    if (parent === absolute) throw cause;
    const physicalParent = await physicalPath(parent);
    const entry = join(physicalParent, basename(absolute));
    if ((await lstatOrNull(entry))?.isSymbolicLink() !== true) return entry;
    return physicalPath(resolve(physicalParent, await readlink(entry)));
  }
}

/**
 * Whether `inner` is `outer` or below it.
 *
 * @param {string} outer
 * @param {string} inner
 */
function contains(outer, inner) {
  return inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : `${outer}${sep}`);
}

/** @param {string} path */
async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch (cause) {
    if (/** @type {NodeJS.ErrnoException} */ (cause).code === 'ENOENT') return null;
    throw cause;
  }
}

/** @param {string} path */
async function present(path) {
  return (await lstatOrNull(path)) !== null;
}
