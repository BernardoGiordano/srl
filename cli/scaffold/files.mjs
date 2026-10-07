/**
 * The name rule and the file writer every scaffold shares. The writer never
 * overwrites, and never writes outside its root.
 *
 * Each scaffold describes its files as a pure `Map` of path to contents, and this
 * module is the one place that writes them. It writes through the confined writer, so
 * a symbolic link in the project can't carry a file out of it. ADR-0073, ADR-0122,
 * ADR-0132.
 */

import { join } from 'node:path';

import { createWithin, entryWithin } from '../delivery/output-tree.mjs';
import { error, info } from '../diagnostics/index.mjs';
import { NOT_APPS } from '../layout.mjs';

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
 * Whether anything sits at `name` in `parent`, a dangling symbolic link included.
 *
 * A scaffold that writes a new directory checks this first. A dangling link would
 * otherwise read as absent, and the scaffold would write wherever it points.
 *
 * @param {string} parent
 * @param {string} name one segment
 * @returns {Promise<boolean>}
 */
export async function occupied(parent, name) {
  return (await entryWithin(parent, name)) !== null;
}

/**
 * Write `files` under `root` and report each one.
 *
 * Any existing entry refuses the whole set, so a refused run leaves the project as it
 * was. A symbolic link counts as existing, even when it points at nothing. A path in
 * `keep` is the exception. It belongs to the project, so an existing copy stays and
 * `keep` says what to report instead.
 *
 * Every path is admitted before anything is written. A path whose directory leaves
 * `root` through a symbolic link refuses the set too, and each file is created
 * exclusively, so one that appears after the check is never overwritten.
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
  const refused = [];
  /** @type {Diagnostic[]} */
  const kept = [];
  /** @type {Set<string>} */
  const skip = new Set();

  for (const path of files.keys()) {
    const file = join(root, path);
    let entry;
    try {
      entry = await entryWithin(root, path);
    } catch (cause) {
      refused.push(
        error('scaffold/unsafe-path', `${detail(cause)} Nothing was written.`, {
          file,
          group: options.group,
        }),
      );
      continue;
    }
    if (entry === null) continue;

    const keep = options.keep?.get(path);
    if (keep === undefined) {
      refused.push(
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
  if (refused.length > 0) return refused;

  /** @type {Diagnostic[]} */
  const written = [];
  for (const [path, contents] of files) {
    if (skip.has(path)) continue;
    await createWithin(root, path, contents);
    written.push(info('scaffold/wrote', path, { group: options.group }));
  }
  return [...written, ...kept];
}

/** @param {unknown} cause */
function detail(cause) {
  return (cause instanceof Error ? cause.message : String(cause)).replace(/^output: /u, '');
}
