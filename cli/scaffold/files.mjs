/**
 * The name rule and the file writer every scaffold shares. The writer never
 * overwrites.
 *
 * Each scaffold describes its files as a pure `Map` of path to contents, and this
 * module is the one place that writes them. ADR-0073, ADR-0122.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { error, info } from '../diagnostics/index.mjs';
import { NOT_APPS, exists } from '../layout.mjs';

/** @import { Diagnostic } from '../diagnostics/types.js' */

/** One lowercase kebab-case segment: a directory, a package name or a tag. */
export const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/**
 * Why `name` cannot name an application directory, or null when it can.
 *
 * @param {string | undefined} name
 * @param {string} example the command line the message suggests
 * @returns {Diagnostic | null}
 */
export function applicationNameProblem(name, example) {
  if (name === undefined || !NAME.test(name)) {
    return error(
      'scaffold/name',
      `${name === undefined ? 'No name given' : `"${name}" is not a name`}. An application ` +
        `is a directory in the project root, so its name is one lowercase kebab-case ` +
        `segment: \`${example}\`.`,
    );
  }
  if (NOT_APPS.has(name)) {
    return error(
      'scaffold/reserved-name',
      `"${name}" is a directory the toolchain never reads as an application, so nothing would ` +
        `ever build what was written there. Reserved: ${[...NOT_APPS].sort().join(', ')}.`,
    );
  }
  return null;
}

/**
 * Write `files` under `root` and report each one.
 *
 * Any existing file refuses the whole set, so a refused run leaves the project as it
 * was. A path in `keep` is the exception. It belongs to the project, so an existing
 * copy stays and `keep` says what to report instead.
 *
 * @param {string} root
 * @param {ReadonlyMap<string, string>} files paths relative to `root`
 * @param {{
 *   group: string,
 *   keep?: ReadonlyMap<string, (file: string) => Diagnostic>,
 * }} options
 * @returns {Promise<Diagnostic[]>}
 */
export async function writeFiles(root, files, options) {
  /** @type {Diagnostic[]} */
  const taken = [];
  /** @type {Diagnostic[]} */
  const kept = [];
  /** @type {Set<string>} */
  const skip = new Set();

  for (const path of files.keys()) {
    const file = join(root, path);
    if (!(await exists(file))) continue;

    const keep = options.keep?.get(path);
    if (keep === undefined) {
      taken.push(
        error('scaffold/exists', 'already exists, so nothing was written.', {
          file,
          group: options.group,
        }),
      );
    } else {
      skip.add(path);
      kept.push(keep(file));
    }
  }
  if (taken.length > 0) return taken;

  /** @type {Diagnostic[]} */
  const written = [];
  for (const [path, contents] of files) {
    if (skip.has(path)) continue;
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, contents);
    written.push(info('scaffold/wrote', path, { group: options.group }));
  }
  return [...written, ...kept];
}
