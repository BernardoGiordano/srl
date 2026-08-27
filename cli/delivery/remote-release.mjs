/**
 * Prepare and manage independently published Remote releases.
 *
 * A Remote artifact already owns its browser graph and versioned URL base. This
 * module re-verifies that interface, stages an exact release, exposes one version
 * alias, and applies retention without teaching the deploy adapter which files
 * belong to the artifact.
 */

import { createHash } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { activateReleasePointer } from './activate-release.mjs';
import { REPORT, isRemoteReport, readReport } from './artifact-report.mjs';
import { applyRetention, planRetention } from './retention.mjs';
import { verifyPublishedRelease } from './verify-release.mjs';

/** @import { ArtifactFile, RemoteArtifactReport, RemoteTransport } from './artifact-report.mjs' */

/**
 * The report retained beside a published Remote release: what was published, from
 * which artifact, at which immutable version URL. `remote` is the Remote's own
 * transport descriptor, carried through unchanged so that composing a shell later
 * needs the release and not the artifact it came from.
 *
 * @typedef {{ version: number, kind: 'remote', app: string, name: string, id: string, artifact: { sha256: string, commit: string | null }, public: { base: string, version: string, directory: string }, remote: RemoteTransport, files: Array<{ target: string, path: string, bytes: number, sha256: string, kind: string }> }} RemoteReleaseReport
 * @typedef {{ artifactRoot: string, outDir: string, allowExperimental?: boolean }} PrepareOptions
 */

/** A release names its artifact by a full commit; a build does not have to. */
const FULL_COMMIT = /^[0-9a-f]{40}$/u;

/**
 * Build a deterministic transport tree from one verified Remote artifact.
 * The output directory must not exist; caller-owned paths are never cleaned.
 *
 * @param {PrepareOptions} options
 */
export async function prepareRemoteRelease(options) {
  const artifactRoot = resolve(options.artifactRoot);
  const output = resolve(options.outDir);
  await requireMissing(output);

  const {
    report,
    bytes: artifactBytes,
    path: artifactPath,
  } = await readReport(artifactRoot);
  const artifact = admitRemoteArtifact(report, artifactPath, options.allowExperimental === true);
  const browserBytes = await verifyRemoteArtifact(artifactRoot, artifact);
  const artifactSha256 = digest(artifactBytes);
  const id = `${artifact.release.commit.slice(0, 12)}-${artifactSha256.slice(0, 12)}`;
  const releaseOutput = join(output, 'release');
  await mkdir(releaseOutput, { recursive: true });

  /** @type {Array<{ target: 'release', path: string, bytes: number, sha256: string, kind: string }>} */
  const files = [];
  for (const file of artifact.files) {
    await copy(inside(artifactRoot, file.path), inside(releaseOutput, file.path));
    files.push({
      target: 'release',
      path: file.path,
      bytes: file.bytes,
      sha256: file.sha256,
      kind: file.cache === 'metadata' ? 'metadata' : 'browser',
    });
  }
  await copy(artifactPath, join(releaseOutput, REPORT));
  files.push({
    target: 'release',
    path: REPORT,
    bytes: artifactBytes.byteLength,
    sha256: artifactSha256,
    kind: 'metadata',
  });
  files.sort((left, right) => left.path.localeCompare(right.path));

  const version = versionFromBase(artifact);
  const release = {
    version: 1,
    kind: 'remote',
    app: artifact.app,
    name: artifact.name,
    id,
    artifact: {
      sha256: artifactSha256,
      commit: artifact.release.commit,
    },
    public: {
      base: artifact.base,
      version,
      directory: artifact.public,
    },
    remote: artifact.remote,
    files,
  };
  const releaseReport = `${JSON.stringify(release, null, 2)}\n`;
  const releaseReportSha256 = digest(releaseReport);
  await writeFile(join(releaseOutput, 'release.json'), releaseReport);

  const publication = {
    version: 1,
    kind: 'remote',
    app: artifact.app,
    name: artifact.name,
    id,
    commit: artifact.release.commit,
    experimental: artifact.experimental,
    artifactSha256,
    releaseReportSha256,
    base: artifact.base,
    publicVersion: version,
    root: output,
    release: releaseOutput,
    totals: {
      files: files.length,
      bytes: files.reduce((total, file) => total + file.bytes, 0),
      browserBytes,
    },
  };
  await writeFile(join(output, 'publication.json'), `${JSON.stringify(publication, null, 2)}\n`);
  return deepFreeze(publication);
}

/**
 * Expose a verified release at its immutable version URL and select it as current.
 * Existing version aliases may never be repointed to different bytes.
 *
 * @param {{ root: string, publicRoot: string, id: string }} options
 */
export async function activateRemoteRelease(options) {
  const root = safeRoot(options.root, 'remote-activate: root');
  const publicRoot = safeRoot(options.publicRoot, 'remote-activate: public root');
  const release = await readRemoteRelease(root, options.id, 'remote-activate');
  await verifyPublishedRelease({
    releaseDir: join(root, 'releases', release.id),
    assetsDir: join(root, 'assets'),
  });
  const alias = inside(publicRoot, release.public.version);
  const target = join(root, 'releases', release.id, release.public.directory);
  await mkdir(publicRoot, { recursive: true });

  await ensureVersionAlias(alias, target, release.public.version);

  const selected = await activateReleasePointer({ root, id: release.id });
  return deepFreeze({
    ...selected,
    app: release.app,
    name: release.name,
    base: release.public.base,
    version: release.public.version,
  });
}

/** @param {string} alias @param {string} target @param {string} version */
async function ensureVersionAlias(alias, target, version) {
  try {
    const currentTarget = resolve(dirname(alias), await readlink(alias));
    if (currentTarget !== target) {
      throw new Error(`remote-activate: version ${version} already names different bytes.`);
    }
    return;
  } catch (cause) {
    if (/** @type {NodeJS.ErrnoException} */ (cause).code !== 'ENOENT') throw cause;
  }
  try {
    await symlink(relative(dirname(alias), target), alias);
  } catch (cause) {
    if (/** @type {NodeJS.ErrnoException} */ (cause).code !== 'EEXIST') throw cause;
    const currentTarget = resolve(dirname(alias), await readlink(alias));
    if (currentTarget !== target) {
      throw new Error(`remote-activate: version ${version} already names different bytes.`);
    }
  }
}

/**
 * Apply the shared release-retention policy and include public version aliases
 * owned only by releases that the plan removes.
 *
 * @param {{ root: string, publicRoot: string, now?: number, keep?: number, graceMs?: number }} options
 */
export async function planRemoteRetention(options) {
  const root = safeRoot(options.root, 'remote-retention: root');
  const publicRoot = safeRoot(options.publicRoot, 'remote-retention: public root');
  const base = await planRetention({
    root,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.keep === undefined ? {} : { keep: options.keep }),
    ...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
  });
  const removedIds = base.deletions
    .filter((entry) => entry.kind === 'release' && /^releases\/[0-9a-f]{12}-[0-9a-f]{12}$/u.test(entry.path))
    .map((entry) => entry.path.slice('releases/'.length));
  const retainedVersions = new Set(
    await Promise.all(
      base.retained.map(async (id) =>
        readRemoteRelease(root, id, 'remote-retention').then((report) => report.public.version),
      ),
    ),
  );
  /** @type {Array<{ version: string, id: string, target: string }>} */
  const aliases = [];
  for (const id of removedIds) {
    const report = await readRemoteRelease(root, id, 'remote-retention');
    if (retainedVersions.has(report.public.version)) continue;
    const path = inside(publicRoot, report.public.version);
    let target;
    try {
      target = resolve(dirname(path), await readlink(path));
    } catch (cause) {
      if (/** @type {NodeJS.ErrnoException} */ (cause).code === 'ENOENT') continue;
      throw cause;
    }
    const expected = join(root, 'releases', id, report.public.directory);
    if (target !== expected) {
      throw new Error(`remote-retention: version alias ${report.public.version} has drifted.`);
    }
    aliases.push({ version: report.public.version, id, target: expected });
  }
  aliases.sort((left, right) => left.version.localeCompare(right.version));
  return deepFreeze({ ...base, publicRoot, aliases });
}

/** @param {Awaited<ReturnType<typeof planRemoteRetention>>} plan */
export async function applyRemoteRetention(plan) {
  const result = await applyRetention(plan);
  for (const alias of plan.aliases) {
    const path = inside(plan.publicRoot, alias.version);
    const target = resolve(dirname(path), await readlink(path));
    if (target !== alias.target) {
      throw new Error(`remote-retention: version alias ${alias.version} changed after planning.`);
    }
    await unlink(path);
  }
  return { deleted: result.deleted + plan.aliases.length };
}

/**
 * What a release requires of an artifact report beyond the report's own contract:
 * a Remote rather than a shell, a full commit to name the release by, a base this
 * module's publication layout recognises, and — unless a PoC deploy says otherwise
 * — a build that is no longer marked experimental.
 *
 * @param {import('./artifact-report.mjs').ArtifactReport} report
 * @param {string} path
 * @param {boolean} allowExperimental
 * @returns {RemoteArtifactReport & { release: { commit: string } }}
 */
function admitRemoteArtifact(report, path, allowExperimental) {
  if (!isRemoteReport(report)) {
    throw new Error(`remote-release: ${path} is a shell artifact, not a Remote one.`);
  }
  const commit = report.release.commit;
  if (commit === null || !FULL_COMMIT.test(commit)) {
    throw new Error(`remote-release: ${path} was not built from a full commit.`);
  }
  versionFromBase(report);
  if (report.experimental === true && !allowExperimental) {
    throw new Error(
      'remote-release: artifact remains experimental; pass --experimental only for an approved PoC deploy.',
    );
  }
  return { ...report, release: { ...report.release, commit } };
}

/** @param {string} artifactRoot @param {RemoteArtifactReport} artifact */
async function verifyRemoteArtifact(artifactRoot, artifact) {
  const expected = new Set([REPORT]);
  /** @type {Map<string, ArtifactFile & { content: Buffer }>} */
  const byPath = new Map();
  for (const file of artifact.files) {
    validateRelative(file.path);
    expected.add(file.path);
    const bytes = await readFile(inside(artifactRoot, file.path));
    if (bytes.byteLength !== file.bytes || digest(bytes) !== file.sha256) {
      throw new Error(`remote-release: hash mismatch for ${file.path}`);
    }
    byPath.set(file.path, { ...file, content: bytes });
  }

  const actual = new Set(
    (await walk(artifactRoot)).map((path) => relative(artifactRoot, path).split(sep).join('/')),
  );
  if (expected.size !== actual.size || [...expected].some((path) => !actual.has(path))) {
    throw new Error('remote-release: artifact inventory differs from disk.');
  }

  const remote = artifact.remote;
  if (!remote.url.startsWith(artifact.base)) {
    throw new Error('remote-release: Remote transport descriptor is malformed.');
  }
  const seen = new Set();
  for (const asset of remote.assets) {
    if (
      !['module', 'style', 'template'].includes(asset.type) ||
      !asset.url.startsWith(artifact.base) ||
      !/^sha384-[A-Za-z0-9+/]{64}$/u.test(asset.integrity) ||
      seen.has(asset.url)
    ) {
      throw new Error(`remote-release: malformed asset record for ${asset.url}`);
    }
    seen.add(asset.url);
    const path = `public/${asset.url.slice(artifact.base.length)}`;
    const file = byPath.get(path);
    if (file === undefined || file.cache !== 'immutable') {
      throw new Error(`remote-release: asset URL has no immutable payload: ${asset.url}`);
    }
    const integrity = `sha384-${createHash('sha384').update(file.content).digest('base64')}`;
    if (integrity !== asset.integrity) {
      throw new Error(`remote-release: integrity mismatch for ${asset.url}`);
    }
  }
  const entryUrl = `${artifact.base}${artifact.entry}`;
  if (remote.url !== entryUrl || !seen.has(entryUrl)) {
    throw new Error('remote-release: entry URL is absent from Remote assets.');
  }
  const entry = remote.assets.find((asset) => asset.url === entryUrl);
  if (entry?.type !== 'module' || entry.integrity !== remote.integrity) {
    throw new Error('remote-release: entry module integrity differs from Remote descriptor.');
  }
  if (
    remote.templates !== undefined &&
    !remote.assets.some((asset) => asset.type === 'template' && asset.url === remote.templates)
  ) {
    throw new Error('remote-release: template bundle is absent from Remote assets.');
  }
  for (const pattern of remote.locales) {
    if (!pattern.startsWith(artifact.base) || !pattern.includes('{locale}')) {
      throw new Error(`remote-release: malformed locale pattern ${pattern}`);
    }
  }
  return [...byPath.values()].reduce((total, file) => total + file.bytes, 0);
}

/** @param {RemoteArtifactReport} artifact */
function versionFromBase(artifact) {
  const prefix = `/remotes/${artifact.name}/`;
  if (!artifact.base.startsWith(prefix)) {
    throw new Error(`remote-release: invalid publication base ${artifact.base}`);
  }
  const version = artifact.base.slice(prefix.length, -1);
  if (!/^[A-Za-z0-9._-]+$/u.test(version)) {
    throw new Error(`remote-release: publication base must contain one safe version: ${artifact.base}`);
  }
  return version;
}

/** @param {string} root @param {string} id @param {string} phase @returns {Promise<RemoteReleaseReport>} */
async function readRemoteRelease(root, id, phase) {
  if (!/^[0-9a-f]{12}-[0-9a-f]{12}$/u.test(id)) {
    throw new Error(`${phase}: invalid release id ${id}`);
  }
  const source = await readFile(join(root, 'releases', id, 'release.json'), 'utf8');
  const report = /** @type {RemoteReleaseReport} */ (/** @type {unknown} */ (JSON.parse(source)));
  if (
    report.version !== 1 ||
    report.kind !== 'remote' ||
    report.id !== id ||
    !/^[a-z0-9][a-z0-9._-]*$/u.test(report.app ?? '') ||
    !/^[a-z0-9][a-z0-9._-]*$/u.test(report.name ?? '') ||
    typeof report.public?.base !== 'string' ||
    !/^[A-Za-z0-9._-]+$/u.test(report.public?.version ?? '') ||
    report.public?.directory !== 'public' ||
    report.public?.base !== `/remotes/${report.name}/${report.public.version}/` ||
    !Array.isArray(report.files)
  ) {
    throw new Error(`${phase}: ${id} has no matching Remote release report.`);
  }
  return report;
}

/** @param {string} path @param {string} where */
function safeRoot(path, where) {
  const root = resolve(path);
  if (root === resolve('/')) throw new Error(`${where} must not be filesystem root.`);
  return root;
}

/** @param {string} path */
async function requireMissing(path) {
  try {
    await lstat(path);
  } catch (cause) {
    if (/** @type {NodeJS.ErrnoException} */ (cause).code === 'ENOENT') return;
    throw cause;
  }
  throw new Error(`remote-release: output already exists: ${path}`);
}

/** @param {string} source @param {string} target */
async function copy(source, target) {
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}

/** @param {string} root @param {string} path */
function inside(root, path) {
  validateRelative(path);
  const target = resolve(root, path);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`remote-release: path escapes root: ${path}`);
  }
  return target;
}

/** @param {string} path */
function validateRelative(path) {
  if (path === '' || path.startsWith('/') || path.split('/').includes('..') || path.includes('\\')) {
    throw new Error(`remote-release: unsafe relative path ${path}`);
  }
}

/** @param {Buffer | string} bytes */
function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** @param {string} root @returns {Promise<string[]>} */
async function walk(root) {
  /** @type {string[]} */
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`remote-release: symbolic or special file is not admitted: ${path}`);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

/** @template T @param {T} value @returns {Readonly<T>} */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** @param {string} name */
function flag(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const command = process.argv[2];
    if (command === 'prepare') {
      const artifactRoot = flag('artifact');
      const outDir = flag('out');
      if (artifactRoot === undefined || outDir === undefined) {
        throw new Error(
          'usage: node remote-release.mjs prepare --artifact <directory> --out <directory> [--experimental]',
        );
      }
      const result = await prepareRemoteRelease({
        artifactRoot,
        outDir,
        allowExperimental: process.argv.includes('--experimental'),
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else if (command === 'activate') {
      const root = process.argv[3];
      const publicRoot = process.argv[4];
      const id = process.argv[5];
      if (root === undefined || publicRoot === undefined || id === undefined) {
        throw new Error(
          'usage: node remote-release.mjs activate <release-root> <public-root> <release-id>',
        );
      }
      process.stdout.write(
        `${JSON.stringify(await activateRemoteRelease({ root, publicRoot, id }))}\n`,
      );
    } else if (command === 'retention') {
      const root = process.argv[3];
      const publicRoot = process.argv[4];
      if (root === undefined || publicRoot === undefined) {
        throw new Error(
          'usage: node remote-release.mjs retention <release-root> <public-root> [--apply]',
        );
      }
      const plan = await planRemoteRetention({ root, publicRoot });
      const applied = process.argv.includes('--apply') ? await applyRemoteRetention(plan) : null;
      process.stdout.write(`${JSON.stringify({ ...plan, applied }, null, 2)}\n`);
    } else {
      throw new Error('usage: node remote-release.mjs prepare|activate|retention ...');
    }
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : cause);
    process.exitCode = 1;
  }
}
