/** Plan and explicitly apply versioned artifact release retention. */

import { readFile, readdir, readlink, rm, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_KEEP = 3;
const DEFAULT_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * @typedef {{ target: string, path: string }} RetentionFile
 * @typedef {{ version: number, id: string, files: RetentionFile[] }} RetentionReport
 */

/**
 * Keep current plus two previous releases, every release younger than seven days,
 * every asset referenced by those releases, and unreferenced assets for seven days.
 *
 * @param {{ root: string, now?: number, keep?: number, graceMs?: number }} options
 */
export async function planRetention(options) {
  const root = resolve(options.root);
  if (root === resolve('/')) throw new Error('retention: refusing filesystem root.');
  const releasesRoot = join(root, 'releases');
  const assetsRoot = join(root, 'assets');
  const keep = options.keep ?? DEFAULT_KEEP;
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(keep) || keep < 1 || !Number.isFinite(graceMs) || graceMs < 0) {
    throw new Error('retention: invalid keep or grace policy.');
  }

  const currentTarget = await readlink(join(root, 'current'));
  const currentPath = resolve(root, currentTarget);
  if (currentPath !== releasesRoot && !currentPath.startsWith(`${releasesRoot}${sep}`)) {
    throw new Error(`retention: current points outside releases: ${currentTarget}`);
  }
  const current = basename(currentPath);
  const allReleaseEntries = await readdir(releasesRoot, { withFileTypes: true });
  const releaseEntries = allReleaseEntries.filter(
    (entry) => entry.isDirectory() && !entry.name.startsWith('.'),
  );
  /** @type {Array<{ id: string, mtimeMs: number, report: RetentionReport }>} */
  const releases = [];
  for (const entry of releaseEntries) {
    const path = join(releasesRoot, entry.name, 'release.json');
    const [info, report] = await Promise.all([
      stat(path),
      readFile(path, 'utf8').then(parseReport),
    ]);
    if (report.version !== 1 || report.id !== entry.name || !Array.isArray(report.files)) {
      throw new Error(`retention: invalid release report in ${entry.name}.`);
    }
    releases.push({ id: entry.name, mtimeMs: info.mtimeMs, report });
  }
  if (!releases.some((release) => release.id === current)) {
    throw new Error(`retention: current release ${current} has no report.`);
  }

  releases.sort((left, right) => right.mtimeMs - left.mtimeMs || left.id.localeCompare(right.id));
  const protectedIds = new Set([
    current,
    ...releases.filter((release) => release.id !== current).slice(0, keep - 1).map((release) => release.id),
  ]);
  const cutoff = now - graceMs;
  const retained = releases.filter(
    (release) => protectedIds.has(release.id) || release.mtimeMs >= cutoff,
  );
  const removed = releases.filter((release) => !retained.includes(release));

  const referencedAssets = new Set(
    retained.flatMap((release) =>
      release.report.files
        .filter((file) => file.target === 'asset' && typeof file.path === 'string')
        .map((file) => file.path),
    ),
  );
  /** @type {Array<{ kind: 'release' | 'asset', path: string, reason: string }>} */
  const deletions = removed.map((release) => ({
    kind: /** @type {'release'} */ ('release'),
    path: `releases/${release.id}`,
    reason: 'outside retained release set and grace window',
  }));
  for (const entry of allReleaseEntries) {
    if (!entry.isDirectory() || !/^\.[0-9a-f]{12}-[0-9a-f]{12}\.pending\.\d+$/u.test(entry.name)) {
      continue;
    }
    const info = await stat(join(releasesRoot, entry.name));
    if (info.mtimeMs < cutoff) {
      deletions.push({
        kind: 'release',
        path: `releases/${entry.name}`,
        reason: 'abandoned pending upload older than grace window',
      });
    }
  }
  for (const path of await walkFiles(assetsRoot)) {
    const name = relative(assetsRoot, path).split(sep).join('/');
    const info = await stat(path);
    if (!referencedAssets.has(name) && info.mtimeMs < cutoff) {
      deletions.push({
        kind: 'asset',
        path: `assets/${name}`,
        reason: 'unreferenced by retained releases and older than grace window',
      });
    }
  }
  deletions.sort((left, right) => left.path.localeCompare(right.path));

  return {
    version: 1,
    root,
    current,
    policy: { keep, graceMs },
    retained: retained.map((release) => release.id),
    deletions,
  };
}

/** @param {string} source @returns {RetentionReport} */
function parseReport(source) {
  const value = /** @type {unknown} */ (JSON.parse(source));
  return /** @type {RetentionReport} */ (value);
}

/** @param {Awaited<ReturnType<typeof planRetention>>} plan */
export async function applyRetention(plan) {
  const root = resolve(plan.root);
  const current = basename(resolve(root, await readlink(join(root, 'current'))));
  if (current !== plan.current) {
    throw new Error('retention: current release changed after the plan was created.');
  }
  for (const deletion of plan.deletions) {
    const target = inside(root, deletion.path);
    if (deletion.kind === 'release') {
      if (basename(target) === current || dirname(target) !== join(root, 'releases')) {
        throw new Error(`retention: refusing release deletion ${deletion.path}`);
      }
      await rm(target, { recursive: true });
    } else {
      if (!target.startsWith(`${join(root, 'assets')}${sep}`)) {
        throw new Error(`retention: refusing asset deletion ${deletion.path}`);
      }
      await unlink(target);
    }
  }
  return { deleted: plan.deletions.length };
}

/** @param {string} root @param {string} path */
function inside(root, path) {
  if (path === '' || path.startsWith('/') || path.split('/').includes('..') || path.includes('\\')) {
    throw new Error(`retention: unsafe path ${path}`);
  }
  const target = resolve(root, path);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`retention: path escapes root ${path}`);
  }
  return target;
}

/** @param {string} root @returns {Promise<string[]>} */
async function walkFiles(root) {
  /** @type {string[]} */
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(path)));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`retention: symbolic or special asset found: ${path}`);
  }
  return files;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const root = process.argv[2];
    if (root === undefined) throw new Error('usage: node retention.mjs <release-root> [--apply]');
    const plan = await planRetention({ root });
    const applied = process.argv.includes('--apply') ? await applyRetention(plan) : null;
    process.stdout.write(`${JSON.stringify({ ...plan, applied }, null, 2)}\n`);
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : cause);
    process.exitCode = 1;
  }
}
