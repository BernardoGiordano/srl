/** Atomically switch one versioned artifact release pointer. */

import { readFile, readlink, rename, symlink } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/** @param {{ root: string, id: string }} options */
export async function activateReleasePointer(options) {
  const root = resolve(options.root);
  const id = options.id;
  if (!/^[0-9a-f]{12}-[0-9a-f]{12}$/u.test(id)) {
    throw new Error(`release-activate: invalid release id ${id}`);
  }
  const release = join(root, 'releases', id);
  const report = JSON.parse(await readFile(join(release, 'release.json'), 'utf8'));
  if (report.version !== 1 || report.id !== id) {
    throw new Error(`release-activate: ${id} has no matching verified release report.`);
  }

  const current = join(root, 'current');
  let previous = null;
  try {
    const target = resolve(root, await readlink(current));
    const releases = join(root, 'releases');
    if (target !== releases && !target.startsWith(`${releases}${sep}`)) {
      throw new Error('release-activate: current points outside versioned releases.');
    }
    previous = basename(target);
  } catch (cause) {
    if (/** @type {NodeJS.ErrnoException} */ (cause).code !== 'ENOENT') throw cause;
  }

  const temporary = join(root, `.current-${id}-${String(process.pid)}`);
  await symlink(`releases/${id}`, temporary);
  await rename(temporary, current);
  return { current: id, previous };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const root = process.argv[2];
    const id = process.argv[3];
    if (root === undefined || id === undefined) {
      throw new Error('usage: node activate-release.mjs <release-root> <release-id>');
    }
    process.stdout.write(`${JSON.stringify(await activateReleasePointer({ root, id }))}\n`);
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : cause);
    process.exitCode = 1;
  }
}
