/**
 * The layout a consumer gets, built from the tarballs this repository would publish.
 *
 * `@srljs/core` and `@srljs/cli` are real directories under `node_modules`, the
 * repository is the working directory, and `@srljs/core/lib/...` is a resolver question
 * rather than a relative path. Nothing in the checkout has that shape, and the difference
 * has broken the build before. ADR-0067, ADR-0068.
 *
 * Two callers need it now — the packaged-install probe and the editor conformance run —
 * so how it is built lives here rather than in whichever check wrote it first.
 */

import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { REPO } from '../../cli/layout.mjs';

const run = promisify(execFile);

/**
 * Run the installed `srl` bin inside `root`. A non-zero exit is data, not a throw: a
 * caller wants to say which step failed and what it printed.
 *
 * @param {string} root
 * @param {string[]} args
 * @returns {Promise<{ code: number, output: string }>}
 */
export async function srl(root, args) {
  const bin = join(root, 'node_modules', '@srljs', 'cli', 'bin', 'srl.mjs');
  try {
    const { stdout, stderr } = await run(process.execPath, [bin, ...args], { cwd: root });
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
 * Pack both workspaces and extract them into `root`'s node_modules.
 *
 *   1. `npm pack` both workspaces — the actual tarballs, so `files` is under test too.
 *   2. Extract into `node_modules/@srljs/` as real directories. Not symlinks: a symlink
 *      resolves to the checkout and every "am I installed?" test would answer no,
 *      because Node resolves realpaths.
 *   3. Link every other dependency from this repository, so the layout needs no network
 *      and pins nothing of its own.
 *
 * @param {string} root
 * @param {{ bundled?: boolean }} [options] `bundled` copies the library's runtime
 *   dependencies rather than linking them, which a caller that builds an artifact needs
 *   and a caller that only runs the toolchain does not.
 * @returns {Promise<void>}
 */
export async function install(root, options = {}) {
  const tarballs = join(root, 'tarballs');
  await mkdir(tarballs, { recursive: true });
  await run(
    'npm',
    ['pack', '--workspace', '@srljs/core', '--workspace', '@srljs/cli', '--pack-destination', tarballs],
    { cwd: REPO },
  );

  const scoped = join(root, 'node_modules', '@srljs');
  for (const [tarball, name] of [
    ['srljs-core-', 'core'],
    ['srljs-cli-', 'cli'],
  ]) {
    const files = await readdir(tarballs);
    const file = files.find((entry) => entry.startsWith(String(tarball)));
    if (file === undefined) throw new Error(`npm pack produced no ${String(tarball)}*.tgz`);
    const target = join(scoped, String(name));
    await mkdir(target, { recursive: true });
    // --strip-components drops the `package/` prefix every npm tarball carries.
    await run('tar', ['xzf', join(tarballs, file), '-C', target, '--strip-components', '1']);
  }

  // Mostly by symlink, with one exception that is not cosmetic. A production bundle
  // inlines the library's runtime dependencies from npm rather than from lib/vendor, so
  // those packages end up as modules *in the artifact*, and the artifact records every
  // module's path relative to the repository. A symlink resolves to this checkout, which
  // is outside the layout, and the build refuses a module it cannot place inside the
  // repository. So the bundled ones are real copies, as the transitive closure rather
  // than a hand-written list, because lit's own layout is lit's business.
  //
  // A scope is a real directory with symlinked packages inside it, never a symlinked
  // directory: linking the scope would make every path under it a way out, and a write
  // meant for the copy would land in this repository's node_modules instead.
  const own = join(REPO, 'node_modules');
  const bundled = options.bundled === true ? await bundledClosure(own) : new Set();

  /** @param {string} name */
  const place = async (name) => {
    const target = join(root, 'node_modules', name);
    if (bundled.has(name)) await cp(join(own, name), target, { recursive: true, dereference: true });
    else await symlink(join(own, name), target);
  };

  for (const entry of await readdir(own, { withFileTypes: true })) {
    if (entry.name === '@srljs') continue;
    if (!entry.name.startsWith('@')) {
      await place(entry.name);
      continue;
    }
    await mkdir(join(root, 'node_modules', entry.name), { recursive: true });
    for (const scoped of await readdir(join(own, entry.name))) {
      await place(`${entry.name}/${scoped}`);
    }
  }
}

/**
 * The library's runtime dependencies and everything they depend on, as installed.
 *
 * @param {string} own this repository's node_modules
 * @returns {Promise<Set<string>>}
 */
async function bundledClosure(own) {
  const manifest = /** @type {{ dependencies?: Record<string, string> }} */ (
    JSON.parse(await readFile(join(REPO, 'source', 'package.json'), 'utf8'))
  );
  /** @type {Set<string>} */
  const found = new Set();
  const queue = Object.keys(manifest.dependencies ?? {});

  while (queue.length > 0) {
    const name = queue.pop();
    if (name === undefined || found.has(name)) continue;
    let nested;
    try {
      nested = /** @type {{ dependencies?: Record<string, string> }} */ (
        JSON.parse(await readFile(join(own, name, 'package.json'), 'utf8'))
      );
    } catch {
      // Not installed at the top level: npm nested it under a dependent, where it is
      // already inside the copy that dependent brings along.
      continue;
    }
    found.add(name);
    queue.push(...Object.keys(nested.dependencies ?? {}));
  }
  return found;
}
