/**
 * Prepare one verified release for transport.
 *
 * Artifact verification, the immutable/versioned split, release identity, and the
 * report a deploy adapter verifies against stay behind this module. Where the
 * release is going does not: that arrives as a ReleaseTarget, and everything a
 * host is named by — site, configuration template, supervisor program, data
 * directory — lives on the far side of it. See ./release-target.mjs.
 *
 * The output directory must not exist; this module never cleans a caller-owned
 * path.
 */

import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { sha256, staticTarget } from './release-target.mjs';

/**
 * @typedef {import('./release-target.mjs').ReleaseTarget} ReleaseTarget
 * @typedef {{ path: string, cache: string, bytes: number, sha256: string }} ArtifactFile
 * @typedef {{ version: number, experimental: boolean, app: string, public: string, release: { commit: string }, security: { csp: string, importMap: { sha256: string } }, files: ArtifactFile[] }} Artifact
 * @typedef {{ artifactRoot: string, outDir: string, target: ReleaseTarget, allowExperimental?: boolean }} PrepareOptions
 */

/**
 * Build a deterministic transport tree from an already-verified browser artifact.
 *
 * @param {PrepareOptions} options
 */
export async function prepareRelease(options) {
  const artifactRoot = resolve(options.artifactRoot);
  const output = resolve(options.outDir);
  const target = options.target;
  await requireMissing(output);

  const artifactPath = join(artifactRoot, 'artifact.json');
  const artifactBytes = await readFile(artifactPath);
  const artifact = parseArtifact(artifactBytes, artifactPath, options.allowExperimental === true);
  if (target.app !== undefined && artifact.app !== target.app) {
    throw new Error(
      `release:artifact: target ${target.name} accepts ${target.app}, not ${artifact.app}.`,
    );
  }
  await verifyArtifactFiles(artifactRoot, artifact.files);

  const artifactSha256 = sha256(artifactBytes);
  const opened = await target.open();
  // Identity covers the artifact, everything the target adds, and every fact the
  // target renders from — so two deployments that differ anywhere a host can see
  // cannot resolve to one release directory.
  const payload = opened.files ?? [];
  const identitySha256 = sha256(
    JSON.stringify({
      artifactSha256,
      target: {
        name: target.name,
        payload: payload.map((file) => ({ path: file.path, sha256: sha256(file.bytes) })),
        identity: opened.identity,
      },
    }),
  );
  const id = `${artifact.release.commit.slice(0, 12)}-${identitySha256.slice(0, 12)}`;
  const remoteRoot = target.remoteRoot;
  const releaseRoot = `${remoteRoot}/releases/${id}`;
  const assetsRoot = `${remoteRoot}/assets`;
  const assetOutput = join(output, 'assets');
  const releaseOutput = join(output, 'release');
  await mkdir(assetOutput, { recursive: true });
  await mkdir(releaseOutput, { recursive: true });

  /** @type {Array<{ target: 'asset' | 'release', path: string, bytes: number, sha256: string, kind: string }>} */
  const files = [];
  for (const file of artifact.files) {
    const source = inside(artifactRoot, file.path);
    if (file.cache === 'immutable') {
      const path = file.path.replace(/^public\/assets\//u, '');
      if (path === file.path) {
        throw new Error(`release:artifact: immutable file is outside public/assets: ${file.path}`);
      }
      await copy(source, inside(assetOutput, path));
      files.push({ target: 'asset', path, bytes: file.bytes, sha256: file.sha256, kind: 'browser' });
    } else {
      await copy(source, inside(releaseOutput, file.path));
      files.push({
        target: 'release',
        path: file.path,
        bytes: file.bytes,
        sha256: file.sha256,
        kind: file.cache === 'metadata' ? 'metadata' : 'browser',
      });
    }
  }

  await copy(artifactPath, join(releaseOutput, 'artifact.json'));
  files.push({
    target: 'release',
    path: 'artifact.json',
    bytes: artifactBytes.byteLength,
    sha256: artifactSha256,
    kind: 'metadata',
  });

  for (const file of payload) {
    await write(inside(releaseOutput, file.path), file.bytes);
    files.push({
      target: 'release',
      path: file.path,
      bytes: file.bytes.byteLength,
      sha256: sha256(file.bytes),
      kind: file.kind,
    });
  }

  const rendering =
    opened.render?.({
      id,
      remoteRoot,
      releaseRoot,
      assetsRoot,
      artifact: {
        app: artifact.app,
        commit: artifact.release.commit,
        csp: artifact.security.csp,
        importMapSha256: artifact.security.importMap.sha256,
      },
    }) ?? {};
  for (const configuration of rendering.configurations ?? []) {
    const bytes = Buffer.from(configuration.source, 'utf8');
    await write(inside(releaseOutput, configuration.path), bytes);
    files.push({
      target: 'release',
      path: configuration.path,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
      kind: 'configuration',
    });
  }

  files.sort((left, right) =>
    `${left.target}/${left.path}`.localeCompare(`${right.target}/${right.path}`),
  );
  const remote = { root: remoteRoot, release: releaseRoot, assets: assetsRoot, ...rendering.remote };
  const release = {
    version: 1,
    app: artifact.app,
    id,
    identitySha256,
    target: target.name,
    artifact: { sha256: artifactSha256, commit: artifact.release.commit },
    remote,
    files,
  };
  const releaseReport = `${JSON.stringify(release, null, 2)}\n`;
  const releaseReportSha256 = sha256(releaseReport);
  await writeFile(join(releaseOutput, 'release.json'), releaseReport);

  const publication = {
    version: 1,
    app: artifact.app,
    id,
    commit: artifact.release.commit,
    experimental: artifact.experimental,
    artifactSha256,
    releaseReportSha256,
    root: output,
    assets: assetOutput,
    release: releaseOutput,
    target: target.name,
    remote,
    totals: {
      assets: files.filter((file) => file.target === 'asset').length,
      release: files.filter((file) => file.target === 'release').length,
      bytes: files.reduce((total, file) => total + file.bytes, 0),
    },
  };
  await writeFile(join(output, 'publication.json'), `${JSON.stringify(publication, null, 2)}\n`);
  return deepFreeze(publication);
}

/** @param {Buffer} bytes @param {string} path @param {boolean} allowExperimental */
function parseArtifact(bytes, path, allowExperimental) {
  /** @type {Artifact} */
  let value;
  try {
    value = /** @type {Artifact} */ (/** @type {unknown} */ (JSON.parse(bytes.toString('utf8'))));
  } catch (cause) {
    throw new Error(`release:artifact: cannot parse ${path}`, { cause });
  }
  if (
    value.version !== 1 ||
    // A remote's report carries `kind`; it is composed into a shell artifact
    // rather than released on its own. See remote-release.mjs.
    /** @type {{ kind?: unknown }} */ (value).kind !== undefined ||
    !/^[a-z0-9][a-z0-9._-]*$/u.test(value.app ?? '') ||
    value.public !== 'public' ||
    !/^[0-9a-f]{40}$/u.test(value.release?.commit ?? '') ||
    !Array.isArray(value.files) ||
    typeof value.security?.csp !== 'string' ||
    typeof value.security?.importMap?.sha256 !== 'string'
  ) {
    throw new Error('release:artifact: artifact.json has an unsupported release contract.');
  }
  if (value.experimental === true && !allowExperimental) {
    throw new Error(
      'release:artifact: artifact remains experimental; pass --experimental only for the approved PoC deploy.',
    );
  }
  if (
    !/^sha256-[A-Za-z0-9+/]+={0,2}$/u.test(value.security.importMap.sha256) ||
    /["\\\r\n]/u.test(value.security.csp) ||
    !value.security.csp.includes(`'${value.security.importMap.sha256}'`)
  ) {
    throw new Error('release:artifact: CSP does not admit the reported import map.');
  }
  return value;
}

/** @param {string} artifactRoot @param {ArtifactFile[]} files */
async function verifyArtifactFiles(artifactRoot, files) {
  const expected = new Set(['artifact.json']);
  for (const file of files) {
    validateRelative(file.path);
    if (
      typeof file.bytes !== 'number' ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      !/^[0-9a-f]{64}$/u.test(file.sha256) ||
      !['immutable', 'revalidate', 'metadata'].includes(file.cache)
    ) {
      throw new Error(`release:artifact: invalid inventory record for ${file.path}`);
    }
    if (expected.has(file.path)) {
      throw new Error(`release:artifact: duplicate inventory path ${file.path}`);
    }
    expected.add(file.path);
    const bytes = await readFile(inside(artifactRoot, file.path));
    if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) {
      throw new Error(`release:artifact: hash mismatch for ${file.path}`);
    }
  }

  const actual = new Set(
    (await walk(artifactRoot)).map((path) => relative(artifactRoot, path).split(sep).join('/')),
  );
  if (expected.size !== actual.size || [...expected].some((path) => !actual.has(path))) {
    const extras = [...actual].filter((path) => !expected.has(path));
    const missing = [...expected].filter((path) => !actual.has(path));
    throw new Error(
      `release:artifact: inventory differs from disk; missing=${missing.join(',') || 'none'} extra=${extras.join(',') || 'none'}`,
    );
  }
}

/** @param {string} path */
async function requireMissing(path) {
  try {
    await lstat(path);
  } catch (cause) {
    if (/** @type {NodeJS.ErrnoException} */ (cause).code === 'ENOENT') return;
    throw cause;
  }
  throw new Error(`release:prepare: output already exists: ${path}`);
}

/** @param {string} source @param {string} target */
async function copy(source, target) {
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}

/** @param {string} target @param {Buffer} bytes */
async function write(target, bytes) {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

/** @param {string} root @param {string} path */
function inside(root, path) {
  validateRelative(path);
  const target = resolve(root, path);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`release:path: ${path} escapes ${root}`);
  }
  return target;
}

/** @param {string} path */
function validateRelative(path) {
  if (path === '' || path.startsWith('/') || path.split('/').includes('..') || path.includes('\\')) {
    throw new Error(`release:path: unsafe relative path ${path}`);
  }
}

/** @param {string} root @returns {Promise<string[]>} */
async function walk(root) {
  /** @type {string[]} */
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`release:path: symbolic or special file is not admitted: ${path}`);
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

/**
 * @param {string} name
 * @returns {string | undefined}
 */
export function flag(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

/* ── As a command ──────────────────────────────────────────────────────────
 *
 * The static target only. A target that names a host is a command in the
 * repository that owns the host: see deploy/targets/.
 */

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const artifactRoot = flag('artifact');
    const outDir = flag('out');
    const remoteRoot = flag('remote-root');
    if (artifactRoot === undefined || outDir === undefined || remoteRoot === undefined) {
      throw new Error(
        'usage: node cli/delivery/release.mjs --artifact <directory> --out <directory> --remote-root <absolute-path> [--experimental]',
      );
    }
    const publication = await prepareRelease({
      artifactRoot,
      outDir,
      target: staticTarget({ remoteRoot }),
      allowExperimental: process.argv.includes('--experimental'),
    });
    process.stdout.write(`${JSON.stringify(publication)}\n`);
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : cause);
    process.exitCode = 1;
  }
}
