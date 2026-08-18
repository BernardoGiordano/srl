/**
 * Build one application's experimental production browser artifact.
 *
 * This is the first slice of the production-artifact module: it owns application
 * selection, source resolution, chunking, minification, template identity, production
 * CSS/HTML, admitted runtime data, deterministic metadata and atomic output replacement.
 * Release transport remains separate and consumes only the verified report and bytes.
 *
 * Vite is implementation. Callers get one function and one artifact report; they do
 * not supply Vite configuration or learn its output object.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompressSync, gzipSync } from 'node:zlib';

import { parse, parseFragment, serialize } from 'parse5';
import ts from 'typescript';
import { build as viteBuild } from 'vite';

import { admitManifest } from '../../source/lib/core/remotes/manifest-policy.js';
import { REPO, readText, selectedApp, walk } from '../layout.mjs';
import { extractImportMap, urlToFile } from '../package/interface.mjs';
import { projectErrors, readProject } from '../project-model/index.mjs';
import { verifyPublishedRelease } from './verify-release.mjs';

const execFileAsync = promisify(execFile);
const DIST = join(REPO, 'dist');
const TARGET = 'es2022';
const PUBLIC = 'public';
const CACHE = {
  immutable: 'public, max-age=31536000, immutable',
  revalidate: 'private, no-cache',
  metadata: null,
};
const HASHED_JAVASCRIPT = /-[A-Za-z0-9_-]{8}\.js$/u;

/**
 * @typedef {{ name: string, dir: string }} BuildApplication
 * @typedef {{ commit?: string | null, sourceDateEpoch?: number | null }} ReleaseInput
 * @typedef {{ app: BuildApplication, outDir?: string, release?: ReleaseInput, remotes?: ReadonlyArray<Readonly<Record<string, unknown>>> }} BuildOptions
 * @typedef {{ tag: string, module: string, template: string, url: string, path: string, source: string }} TemplateAsset
 */

/**
 * Build minimized, hash-named JavaScript chunks into an atomically replaced output.
 *
 * @param {BuildOptions} options
 * @returns {Promise<Readonly<Record<string, unknown>>>}
 */
export async function buildArtifact({
  app,
  outDir = join(DIST, app.name),
  release = {},
  remotes = [],
}) {
  validateApp(app);
  const root = validateOutput(outDir, app);
  const normalizedRelease = normalizeRelease(release, app);
  const model = await readProject(app);
  const errors = projectErrors(model);

  if (model.entry === null) {
    throw artifactError(app, 'model', 'index.html has no root-absolute module entry.');
  }
  if (errors.length > 0) {
    throw artifactError(
      app,
      'model',
      errors.map((diagnostic) => diagnostic.message).join('\n'),
    );
  }
  const source = await sourceManifest(app);
  const composition = composeRemotes(app, source.admitted, remotes);

  const parent = dirname(root);
  await mkdir(parent, { recursive: true });
  const stage = await mkdtemp(join(parent, `.${app.name}-artifact-`));
  const publicDir = join(stage, PUBLIC);

  try {
    const sharedEntries = await resolveSharedEntries(app, source.imports, composition.shared);
    const resolver = await importMapResolver(app, model.prefixes);
    const templates = templateTransform(app, model, '/');
    const css = await productionCss(app, stage, model.entry);
    const html = productionHtml(app);
    const buildOutput = await viteBuild({
      appType: 'custom',
      configFile: false,
      envFile: false,
      logLevel: 'silent',
      mode: 'production',
      plugins: [resolver, templates.plugin, css.plugin, html],
      publicDir: false,
      root: app.dir,
      build: {
        assetsDir: 'assets',
        assetsInlineLimit: 0,
        copyPublicDir: false,
        emptyOutDir: true,
        license: { fileName: 'THIRD_PARTY_LICENSES.md' },
        minify: 'oxc',
        modulePreload: false,
        outDir: publicDir,
        sourcemap: false,
        target: TARGET,
        rolldownOptions: {
          input: buildInputs(app, sharedEntries),
          preserveEntrySignatures: 'strict',
          output: {
            assetFileNames: 'assets/[name]-[hash][extname]',
            chunkFileNames: 'assets/[name]-[hash].js',
            entryFileNames: (chunk) =>
              chunk.name === 'index' || chunk.facadeModuleId?.split('?')[0] === model.entry
                ? 'assets/entry-[hash].js'
                : 'assets/shared/[name]-[hash].js',
          },
        },
      },
    });

    const chunks = chunkRelationships(app, buildOutput);
    const shared = sharedOutputs(app, chunks, sharedEntries);
    await rm(css.temporary, { force: true });
    await emitLicenses(stage, publicDir);
    const templateOutput = await emitTemplateFiles(app, publicDir, templates.assets(), '/');
    const manifest = await emitApplicationManifest(
      app,
      publicDir,
      source.raw,
      templateOutput.url,
      composition.remotes,
    );
    await emitRuntimeData(app, publicDir, normalizedRelease, manifest);
    const security = await emitSecurity(
      app,
      publicDir,
      chunks,
      shared,
      composition.moduleAssets,
    );
    await verifyBrowserRoot(app, publicDir);
    const payload = await inventory(stage);
    verifyPayload(app, payload, templateOutput, chunks);
    const entryModule = relative(REPO, model.entry).split(sep).join('/');
    const entry = chunks.find(
      (chunk) =>
        chunk.entry && (chunk.facade === entryModule || chunk.modules.includes(entryModule)),
    )?.path;
    if (entry === undefined) {
      throw artifactError(app, 'verify', 'generated output has no hash-named entry chunk.');
    }

    const report = {
      version: 1,
      experimental: true,
      root: '.',
      public: PUBLIC,
      app: app.name,
      release: normalizedRelease,
      target: TARGET,
      cache: CACHE,
      entry,
      chunks,
      shared,
      remotes: composition.remotes,
      security,
      templates: templateOutput,
      files: payload,
      totals: payload.reduce(
        (totals, file) => ({
          files: totals.files + 1,
          bytes: totals.bytes + file.bytes,
          gzip: totals.gzip + file.gzip,
          brotli: totals.brotli + file.brotli,
        }),
        { files: 0, bytes: 0, gzip: 0, brotli: 0 },
      ),
    };

    await writeFile(join(stage, 'artifact.json'), `${JSON.stringify(report, null, 2)}\n`);
    await publish(stage, root, app);

    return deepFreeze({ ...report, root });
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    if (error instanceof Error && error.message.startsWith(`artifact:${app.name}:`)) throw error;
    throw artifactError(app, 'build', error instanceof Error ? error.message : String(error), {
      cause: error,
    });
  }
}

/**
 * Recompose one verified shell artifact from independently retained Remote releases.
 * Shell implementation chunks stay byte-identical; only the manifest, integrity import
 * map, CSP metadata, inventory, and artifact report change.
 *
 * @param {{ app: BuildApplication, artifactRoot: string, outDir: string, remotes: ReadonlyArray<Readonly<Record<string, unknown>>> }} options
 * @returns {Promise<Readonly<Record<string, unknown>>>}
 */
export async function composeArtifact({ app, artifactRoot, outDir, remotes }) {
  validateApp(app);
  const sourceRoot = resolve(artifactRoot);
  const root = validateOutput(outDir, app);
  if (sourceRoot === root) {
    throw artifactError(app, 'compose', 'composition output must differ from its source artifact.');
  }
  const reportPath = join(sourceRoot, 'artifact.json');
  const report = artifactRecord(
    JSON.parse(await readFile(reportPath, 'utf8')),
    `${reportPath} report`,
  );
  if (
    report.version !== 1 ||
    report.kind !== undefined ||
    report.app !== app.name ||
    report.public !== PUBLIC ||
    !Array.isArray(report.files) ||
    !Array.isArray(report.remotes) ||
    !Array.isArray(report.chunks)
  ) {
    throw artifactError(app, 'compose', 'source artifact has an unsupported shell contract.');
  }
  await verifyStoredArtifact(app, sourceRoot, report);
  const releases = await verifyCompositionReleases(app, remotes);

  const parent = dirname(root);
  await mkdir(parent, { recursive: true });
  const stage = await mkdtemp(join(parent, `.${app.name}-composition-`));
  try {
    await cp(sourceRoot, stage, { recursive: true });
    await rm(join(stage, 'artifact.json'));
    const publicDir = join(stage, PUBLIC);
    const htmlPath = join(publicDir, 'index.html');
    const manifestPath = join(publicDir, 'app.manifest.json');
    const [html, manifestSource] = await Promise.all([
      readFile(htmlPath, 'utf8'),
      readFile(manifestPath, 'utf8'),
    ]);
    const currentMap = extractImportMap(html, `${app.name} artifact index.html`);
    const manifestDocument = artifactRecord(
      JSON.parse(manifestSource),
      `${app.name} artifact manifest`,
    );
    const currentManifest = admitManifest(manifestDocument, {
      url: `${app.name}/app.manifest.json`,
      base: 'https://artifact.invalid/',
      pins: () => currentMap.integrity,
    });
    const composition = composeRemotes(app, currentManifest, releases);
    const shared = Object.keys(currentMap.imports).sort((left, right) => left.localeCompare(right));
    if (JSON.stringify(shared) !== JSON.stringify(composition.shared)) {
      throw artifactError(
        app,
        'compose',
        'retained Remote shared interface differs from shell facade entries.',
      );
    }

    const oldRemoteModules = new Set(
      currentManifest.remotes.flatMap((remote) =>
        (remote.assets ?? [])
          .filter((asset) => asset.type === 'module')
          .map((asset) => asset.url),
      ),
    );
    /** @type {Record<string, string>} */
    const integrity = Object.fromEntries(
      Object.entries(currentMap.integrity).filter(([url]) => !oldRemoteModules.has(url)),
    );
    for (const remote of composition.moduleAssets) {
      if (integrity[remote.url] !== undefined && integrity[remote.url] !== remote.integrity) {
        throw artifactError(app, 'compose', `two module assets claim ${remote.url}.`);
      }
      integrity[remote.url] = remote.integrity;
    }
    const importMap = JSON.stringify({ imports: currentMap.imports, integrity });
    const inlineHash = importMapHash(importMap);
    await writeFile(htmlPath, replaceImportMap(app, html, importMap));

    const nextManifest = { ...manifestDocument, remotes: composition.remotes };
    admitManifest(nextManifest, {
      url: `${app.name}/app.manifest.json`,
      base: 'https://artifact.invalid/',
      pins: () => integrity,
    });
    await writeFile(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);

    const security = {
      importMap: { source: importMap, sha256: inlineHash },
      modules: Object.entries(integrity).map(([path, value]) => ({ path, integrity: value })),
      csp: cspForImportMap(inlineHash),
    };
    await verifyBrowserRoot(app, publicDir);
    const payload = await inventory(stage);
    verifyPayload(
      app,
      payload,
      /** @type {Awaited<ReturnType<typeof emitTemplateFiles>>} */ (report.templates),
      /** @type {ReturnType<typeof chunkRelationships>} */ (report.chunks),
    );
    const composed = {
      ...report,
      root: '.',
      remotes: composition.remotes,
      security,
      files: payload,
      totals: totalsOf(payload),
    };
    await writeFile(join(stage, 'artifact.json'), `${JSON.stringify(composed, null, 2)}\n`);
    await publish(stage, root, app);
    return deepFreeze({ ...composed, root });
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    if (error instanceof Error && error.message.startsWith(`artifact:${app.name}:`)) throw error;
    throw artifactError(app, 'compose', error instanceof Error ? error.message : String(error), {
      cause: error,
    });
  }
}

/**
 * Build one manifest-declared Remote as its own verified, atomically published artifact.
 * Shell policy stays outside this interface; returned transport descriptor is composed
 * into a shell artifact later.
 *
 * @param {{ app: BuildApplication, name: string, outDir?: string, base?: string, release?: ReleaseInput }} options
 * @returns {Promise<Readonly<Record<string, unknown>>>}
 */
export async function buildRemoteArtifact({ app, name, outDir, base, release = {} }) {
  validateApp(app);
  const normalizedRelease = normalizeRelease(release, app);
  const version = normalizedRelease.commit ?? 'development';
  const publicationBase = validateRemoteBase(app, name, base ?? `/remotes/${name}/${version}/`);
  const root = validateOutput(outDir ?? join(DIST, 'remotes', name, version), app);
  const source = await sourceManifest(app);
  const policy = source.admitted.remotes.find((remote) => remote.name === name);
  if (policy === undefined) throw artifactError(app, 'remote', `manifest declares no remote ${name}.`);
  const entry = urlToFile(app.dir, policy.url);
  const remoteDir = dirname(entry);
  const insideRemote = relative(join(app.dir, 'remotes'), remoteDir);
  if (insideRemote === '..' || insideRemote.startsWith(`..${sep}`) || insideRemote === '') {
    throw artifactError(app, 'remote', `${policy.url} is not inside ${app.name}/remotes/.`);
  }

  const model = await readProject(app);
  const errors = projectErrors(model);
  if (errors.length > 0) {
    throw artifactError(
      app,
      'model',
      errors.map((diagnostic) => diagnostic.message).join('\n'),
    );
  }

  const parent = dirname(root);
  await mkdir(parent, { recursive: true });
  const stage = await mkdtemp(join(parent, `.${name}-remote-artifact-`));
  const publicDir = join(stage, PUBLIC);

  try {
    const templates = templateTransform(app, model, publicationBase);
    const css = await productionRemoteCss(app, remoteDir, stage, entry);
    const buildOutput = await viteBuild({
      appType: 'custom',
      configFile: false,
      envFile: false,
      logLevel: 'silent',
      mode: 'production',
      plugins: [remoteImportResolver(app, policy.shared), templates.plugin, css.plugin],
      publicDir: false,
      root: remoteDir,
      build: {
        assetsDir: 'assets',
        assetsInlineLimit: 0,
        copyPublicDir: false,
        emptyOutDir: true,
        license: { fileName: 'THIRD_PARTY_LICENSES.md' },
        minify: 'oxc',
        modulePreload: false,
        outDir: publicDir,
        sourcemap: false,
        target: TARGET,
        rolldownOptions: {
          input: entry,
          preserveEntrySignatures: 'strict',
          output: {
            assetFileNames: 'assets/[name]-[hash][extname]',
            chunkFileNames: 'assets/[name]-[hash].js',
            entryFileNames: 'assets/remote-entry-[hash].js',
          },
        },
      },
    });

    const chunks = chunkRelationships(app, buildOutput);
    await rm(css.temporary, { force: true });
    await rm(css.input, { force: true });
    await emitLicenses(stage, publicDir);
    const templateAssets = templates.assets();
    const templateOutput =
      templateAssets.length === 0
        ? null
        : await emitTemplateFiles(app, publicDir, templateAssets, publicationBase);
    const locales = await emitRemoteLocales(
      app,
      remoteDir,
      publicDir,
      publicationBase,
      source.admitted.i18n,
      policy.locales,
    );
    await writeFile(
      join(publicDir, 'build.json'),
      `${JSON.stringify(
        { version: 1, app: app.name, remote: name, release: normalizedRelease, target: TARGET },
        null,
        2,
      )}\n`,
    );

    const payload = await inventory(stage);
    const entryModule = relative(REPO, entry).split(sep).join('/');
    const remoteEntry = chunks.find(
      (chunk) => chunk.entry && chunk.facade === entryModule,
    )?.path;
    if (remoteEntry === undefined) {
      throw artifactError(app, 'remote', `${name} generated no hash-named entry chunk.`);
    }
    const assets = await remoteAssetRecords(publicDir, publicationBase, chunks, payload, templateOutput);
    const entryAsset = assets.find(
      (asset) => asset.type === 'module' && asset.url === `${publicationBase}${remoteEntry}`,
    );
    if (entryAsset === undefined) throw artifactError(app, 'remote', `${name} entry has no integrity.`);
    const remote = {
      name,
      url: entryAsset.url,
      integrity: entryAsset.integrity,
      assets,
      shared: [...policy.shared],
      locales,
      ...(templateOutput === null ? {} : { templates: templateOutput.url }),
    };
    verifyRemotePayload(app, name, payload, chunks, remoteEntry, templateOutput);

    const report = {
      version: 1,
      kind: 'remote',
      experimental: true,
      root: '.',
      public: PUBLIC,
      base: publicationBase,
      app: app.name,
      name,
      release: normalizedRelease,
      target: TARGET,
      cache: CACHE,
      entry: remoteEntry,
      chunks,
      remote,
      templates: templateOutput,
      files: payload,
      totals: totalsOf(payload),
    };
    await writeFile(join(stage, 'artifact.json'), `${JSON.stringify(report, null, 2)}\n`);
    await publish(stage, root, app);
    return deepFreeze({ ...report, root });
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    if (error instanceof Error && error.message.startsWith(`artifact:${app.name}:`)) throw error;
    throw artifactError(app, 'remote', error instanceof Error ? error.message : String(error), {
      cause: error,
    });
  }
}

/** @param {BuildApplication} app */
async function sourceManifest(app) {
  try {
    const raw = JSON.parse(await readFile(join(app.dir, 'app.manifest.json'), 'utf8'));
    const html = await readText(join(app.dir, 'index.html'));
    const { imports, integrity } = extractImportMap(html, `${app.name}/index.html`);
    const admitted = admitManifest(raw, {
      url: `${app.name}/app.manifest.json`,
      base: 'https://artifact.invalid/',
      pins: () => integrity,
    });
    return { raw, admitted, imports };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`artifact:${app.name}:`)) throw error;
    throw artifactError(app, 'manifest', error instanceof Error ? error.message : String(error), {
      cause: error,
    });
  }
}

/**
 * Keep access policy in the shell manifest while replacing only each remote's transport
 * facts with one independently verified artifact report.
 *
 * @param {BuildApplication} app
 * @param {import('../../source/lib/core/remotes/types.js').AppManifest} source
 * @param {ReadonlyArray<Readonly<Record<string, unknown>>>} reports
 */
function composeRemotes(app, source, reports) {
  if (source.remotes.length === 0) {
    if (reports.length > 0) throw artifactError(app, 'remotes', 'application declares no remotes.');
    return { remotes: [], shared: [], moduleAssets: [] };
  }

  const byName = new Map();
  for (const report of reports) {
    if (report.kind !== 'remote' || report.app !== app.name) {
      throw artifactError(app, 'remotes', 'remote report belongs to another artifact or application.');
    }
    const remote = recordValue(report.remote, `${String(report.root)} remote report`);
    const name = stringValue(remote.name, 'remote report name');
    if (byName.has(name)) throw artifactError(app, 'remotes', `duplicate artifact for remote ${name}.`);
    byName.set(name, remote);
  }

  const composed = source.remotes.map((policy) => {
    const transport = byName.get(policy.name);
    if (transport === undefined) {
      throw artifactError(app, 'remotes', `missing independent artifact for remote ${policy.name}.`);
    }
    byName.delete(policy.name);
    const shared = stringArray(transport.shared, `remote ${policy.name} shared`);
    if (JSON.stringify(shared) !== JSON.stringify(policy.shared)) {
      throw artifactError(app, 'remotes', `remote ${policy.name} changed its shared dependency interface.`);
    }
    return {
      name: policy.name,
      url: String(transport.url),
      integrity: String(transport.integrity),
      assets: transport.assets,
      shared,
      locales: transport.locales,
      ...(transport.templates === undefined ? {} : { templates: transport.templates }),
      mount: policy.mount,
      requires: policy.requires,
      grants: policy.grants,
    };
  });
  if (byName.size > 0) {
    throw artifactError(app, 'remotes', `artifact names undeclared remote ${[...byName.keys()].join(', ')}.`);
  }

  const shared = [...new Set(composed.flatMap((remote) => stringArray(remote.shared, 'shared')))].sort();
  const moduleAssets = composed.flatMap((remote) =>
    arrayValue(remote.assets, `remote ${remote.name} assets`)
      .map((asset) => recordValue(asset, `remote ${remote.name} asset`))
      .filter((asset) => asset.type === 'module')
      .map((asset) => ({ url: String(asset.url), integrity: String(asset.integrity) })),
  );
  return { remotes: composed, shared, moduleAssets };
}

/** @param {unknown} value @param {string} where */
function artifactRecord(value, where) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where} must be an object.`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * Recompute one stored artifact inventory before using it as composition input.
 *
 * @param {BuildApplication} app
 * @param {string} root
 * @param {Record<string, unknown>} report
 */
async function verifyStoredArtifact(app, root, report) {
  const actual = (await inventory(root)).filter((file) => file.path !== 'artifact.json');
  const expected = arrayValue(report.files, `${app.name} artifact files`).map((file) =>
    artifactRecord(file, `${app.name} artifact file`),
  );
  if (actual.length !== expected.length) {
    throw artifactError(app, 'compose', 'source artifact inventory differs from disk.');
  }
  const byPath = new Map(expected.map((file) => [String(file.path), file]));
  for (const file of actual) {
    const record = byPath.get(file.path);
    if (
      record === undefined ||
      record.cache !== file.cache ||
      record.bytes !== file.bytes ||
      record.gzip !== file.gzip ||
      record.brotli !== file.brotli ||
      record.sha256 !== file.sha256
    ) {
      throw artifactError(app, 'compose', `source artifact hash mismatch for ${file.path}.`);
    }
  }
}

/**
 * Composition consumes retained release reports, not unverified transport objects.
 *
 * @param {BuildApplication} app
 * @param {ReadonlyArray<Readonly<Record<string, unknown>>>} reports
 */
async function verifyCompositionReleases(app, reports) {
  const verified = [];
  for (const candidate of reports) {
    const report = artifactRecord(candidate, `${app.name} Remote release`);
    const root = stringValue(report.root, `${app.name} Remote release root`);
    const publicRecord = artifactRecord(report.public, `${app.name} Remote release public`);
    if (
      report.version !== 1 ||
      report.kind !== 'remote' ||
      report.app !== app.name ||
      publicRecord.directory !== PUBLIC ||
      !Array.isArray(report.files)
    ) {
      throw artifactError(app, 'compose', 'Remote input is not a retained release report.');
    }
    await verifyPublishedRelease({ releaseDir: root, assetsDir: join(root, '.unused-assets') });
    verified.push(report);
  }
  return verified;
}

/**
 * @param {BuildApplication} app
 * @param {Record<string, unknown>} imports
 * @param {readonly string[]} shared
 */
async function resolveSharedEntries(app, imports, shared) {
  const orderedPrefixes = Object.entries(imports)
    .filter(([specifier, url]) => specifier.endsWith('/') && String(url).startsWith('/'))
    .sort(([left], [right]) => right.length - left.length);
  const entries = [];
  for (const [index, specifier] of shared.entries()) {
    let url = typeof imports[specifier] === 'string' ? imports[specifier] : undefined;
    if (url === undefined) {
      const prefix = orderedPrefixes.find(([candidate]) => specifier.startsWith(candidate));
      if (prefix !== undefined) url = `${String(prefix[1])}${specifier.slice(prefix[0].length)}`;
    }
    if (url === undefined || !url.startsWith('/')) {
      throw artifactError(app, 'shared', `${specifier} has no same-origin source import-map target.`);
    }
    const file = urlToFile(app.dir, url);
    try {
      await access(file);
    } catch {
      throw artifactError(app, 'shared', `${specifier} resolves to missing ${file}.`);
    }
    entries.push({ specifier, file, name: `shared-${String(index)}` });
  }
  return entries;
}

/** @param {BuildApplication} app @param {Array<{ name: string, file: string }>} entries */
function buildInputs(app, entries) {
  if (entries.length === 0) return join(app.dir, 'index.html');
  /** @type {Record<string, string>} */
  const inputs = { index: join(app.dir, 'index.html') };
  for (const entry of entries) inputs[entry.name] = entry.file;
  return inputs;
}

/**
 * @param {BuildApplication} app
 * @param {ReturnType<typeof chunkRelationships>} chunks
 * @param {Array<{ specifier: string, file: string }>} entries
 */
function sharedOutputs(app, chunks, entries) {
  return Object.fromEntries(
    entries.map((entry) => {
      const facade = relative(REPO, entry.file).split(sep).join('/');
      const chunk = chunks.find((candidate) => candidate.entry && candidate.facade === facade);
      if (chunk === undefined) {
        throw artifactError(app, 'shared', `${entry.specifier} produced no public facade chunk.`);
      }
      return [entry.specifier, `/${chunk.path}`];
    }),
  );
}

/**
 * @param {BuildApplication} app
 * @param {string} publicDir
 * @param {Record<string, unknown>} source
 * @param {string} templateBundle
 * @param {ReadonlyArray<Record<string, unknown>>} remotes
 */
async function emitApplicationManifest(app, publicDir, source, templateBundle, remotes) {
  const manifest = { ...source, remotes, templateBundle };
  const pins = Object.fromEntries(
    remotes.flatMap((remote) =>
      arrayValue(remote.assets, `remote ${String(remote.name)} assets`)
        .map((asset) => recordValue(asset, 'remote asset'))
        .filter((asset) => asset.type === 'module')
        .map((asset) => [String(asset.url), String(asset.integrity)]),
    ),
  );
  const admitted = admitManifest(manifest, {
    url: `${app.name}/app.manifest.json`,
    base: 'https://artifact.invalid/',
    pins: () => pins,
  });
  await writeFile(join(publicDir, 'app.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return admitted;
}

/** @param {unknown} value @param {string} where */
function recordValue(value, where) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where} must be an object.`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value @param {string} where */
function arrayValue(value, where) {
  if (!Array.isArray(value)) throw new Error(`${where} must be an array.`);
  return /** @type {unknown[]} */ (value);
}

/** @param {unknown} value @param {string} where */
function stringArray(value, where) {
  return arrayValue(value, where).map((entry) => {
    if (typeof entry !== 'string' || entry === '') throw new Error(`${where} must contain strings.`);
    return entry;
  });
}

/** @param {unknown} value @param {string} where */
function stringValue(value, where) {
  if (typeof value !== 'string' || value === '') throw new Error(`${where} must be a string.`);
  return value;
}

/** @param {BuildApplication} app @param {string} name @param {string} base */
function validateRemoteBase(app, name, base) {
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(name)) {
    throw artifactError(app, 'remote', `invalid remote name: ${name}`);
  }
  const prefix = `/remotes/${name}/`;
  const parsed = new URL(base, 'https://artifact.invalid/');
  if (
    !base.startsWith(prefix) ||
    base === prefix ||
    !base.endsWith('/') ||
    parsed.pathname !== base ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw artifactError(
      app,
      'remote',
      `publication base must be a versioned root below ${prefix}: ${base}`,
    );
  }
  return base;
}

/** @param {BuildApplication} app @param {readonly string[]} shared */
function remoteImportResolver(app, shared) {
  const allowed = new Set(shared);
  return /** @type {import('vite').Plugin} */ ({
    name: 'remote-shared-dependencies',
    enforce: 'pre',
    resolveId(source) {
      if (source.startsWith('\0')) return null;
      if (source === REPO || source.startsWith(`${REPO}${sep}`)) return source;
      if (allowed.has(source)) return { id: source, external: true };
      if (isBare(source)) {
        throw artifactError(app, 'remote', `bare import is absent from shared interface: ${source}`);
      }
      if (source.startsWith('/')) {
        throw artifactError(app, 'remote', `root-absolute import bypasses remote artifact: ${source}`);
      }
      return null;
    },
  });
}

/**
 * @param {BuildApplication} app
 * @param {string} remoteDir
 * @param {string} publicDir
 * @param {string} base
 * @param {import('../../source/lib/core/localization/types.js').I18nConfig} i18n
 * @param {readonly string[]} patterns
 */
async function emitRemoteLocales(app, remoteDir, publicDir, base, i18n, patterns) {
  const emitted = [];
  for (const pattern of patterns) {
    const marker = '__ARTIFACT_LOCALE__';
    const patternFile = urlToFile(app.dir, pattern.replaceAll('{locale}', marker));
    const relativePatternFile = relative(remoteDir, patternFile);
    if (
      relativePatternFile === '..' ||
      relativePatternFile.startsWith(`..${sep}`) ||
      relativePatternFile === ''
    ) {
      throw artifactError(app, 'remote', `locale pattern leaves its remote: ${pattern}`);
    }
    let copied = 0;
    for (const locale of i18n.supportedLocales) {
      const source = urlToFile(app.dir, pattern.replaceAll('{locale}', locale));
      if (!(await exists(source))) continue;
      const destination = relative(remoteDir, source);
      await mkdir(dirname(join(publicDir, destination)), { recursive: true });
      const bytes = await readFile(source, 'utf8');
      JSON.parse(bytes);
      await writeFile(join(publicDir, destination), bytes);
      copied += 1;
    }
    if (copied === 0) throw artifactError(app, 'remote', `locale pattern has no files: ${pattern}`);
    const relativePattern = relativePatternFile
      .split(sep)
      .join('/')
      .replaceAll(marker, '{locale}');
    emitted.push(`${base}${relativePattern}`);
  }
  return emitted;
}

/**
 * @param {string} publicDir
 * @param {string} base
 * @param {ReturnType<typeof chunkRelationships>} chunks
 * @param {Awaited<ReturnType<typeof inventory>>} payload
 * @param {{ bundle: string, url: string } | null} templates
 */
async function remoteAssetRecords(publicDir, base, chunks, payload, templates) {
  const records = [];
  for (const chunk of chunks) {
    records.push({
      type: 'module',
      url: `${base}${chunk.path}`,
      integrity: await sri384(join(publicDir, chunk.path)),
    });
  }
  for (const file of payload.filter((candidate) => candidate.path.endsWith('.css'))) {
    const path = file.path.replace(/^public\//u, '');
    records.push({ type: 'style', url: `${base}${path}`, integrity: await sri384(join(publicDir, path)) });
  }
  if (templates !== null) {
    records.push({
      type: 'template',
      url: templates.url,
      integrity: await sri384(join(publicDir, templates.bundle)),
    });
  }
  return records;
}

/** @param {string} path */
async function sri384(path) {
  return `sha384-${createHash('sha384').update(await readFile(path)).digest('base64')}`;
}

/**
 * @param {BuildApplication} app
 * @param {string} name
 * @param {Awaited<ReturnType<typeof inventory>>} files
 * @param {ReturnType<typeof chunkRelationships>} chunks
 * @param {string} entry
 * @param {{ bundle: string } | null} templates
 */
function verifyRemotePayload(app, name, files, chunks, entry, templates) {
  const javascript = files.filter((file) => file.path.endsWith('.js'));
  if (javascript.length === 0 || chunks.length !== javascript.length) {
    throw artifactError(app, 'remote', `${name} has an incomplete JavaScript graph.`);
  }
  if (!chunks.some((chunk) => chunk.path === entry && chunk.entry)) {
    throw artifactError(app, 'remote', `${name} entry is absent from its graph.`);
  }
  for (const file of javascript) {
    if (!HASHED_JAVASCRIPT.test(file.path)) {
      throw artifactError(app, 'remote', `JavaScript chunk is not hash-named: ${file.path}`);
    }
  }
  const forbiddenModules = chunks
    .flatMap((chunk) => chunk.modules)
    .filter(
      (module) =>
        module !== '\0production-artifact.css' &&
        !module.startsWith(`${app.name}/remotes/${name}/`),
    );
  if (forbiddenModules.length > 0) {
    throw artifactError(
      app,
      'remote',
      `${name} bundled modules outside its artifact: ${forbiddenModules.join(', ')}.`,
    );
  }
  if (!files.some((file) => file.path === 'THIRD_PARTY_LICENSES.md')) {
    throw artifactError(app, 'remote', `${name} emitted no license artifact.`);
  }
  if (!files.some((file) => file.path === `${PUBLIC}/build.json`)) {
    throw artifactError(app, 'remote', `${name} emitted no build metadata.`);
  }
  if (templates !== null && !files.some((file) => file.path === `${PUBLIC}/${templates.bundle}`)) {
    throw artifactError(app, 'remote', `${name} template bundle is missing.`);
  }
  const unknown = files.filter((file) => file.cache === 'unknown').map((file) => file.path);
  if (unknown.length > 0) {
    throw artifactError(app, 'remote', `output is outside the artifact allowlist: ${unknown.join(', ')}`);
  }
}

/** @param {Awaited<ReturnType<typeof inventory>>} files */
function totalsOf(files) {
  return files.reduce(
    (totals, file) => ({
      files: totals.files + 1,
      bytes: totals.bytes + file.bytes,
      gzip: totals.gzip + file.gzip,
      brotli: totals.brotli + file.brotli,
    }),
    { files: 0, bytes: 0, gzip: 0, brotli: 0 },
  );
}

/**
 * Compile the existing application stylesheet with the exact pinned Tailwind CLI, then
 * expose those bytes to Vite as one private CSS module imported by the application entry.
 * The temporary file lives inside the isolated stage and is removed before inventory.
 *
 * @param {BuildApplication} app
 * @param {string} stage
 * @param {string} entry
 */
async function productionCss(app, stage, entry) {
  const temporary = join(stage, '.production.css');
  return compileProductionCss(app, join(app.dir, 'src', 'app.css'), temporary, entry);
}

/**
 * @param {BuildApplication} app
 * @param {string} input
 * @param {string} temporary
 * @param {string} entry
 * @param {string} [requiredUtility]
 * @param {string} [sourceBase]
 */
async function compileProductionCss(
  app,
  input,
  temporary,
  entry,
  requiredUtility = '.bg-canvas',
  sourceBase = REPO,
) {
  const cli = join(REPO, 'node_modules', '.bin', 'tailwindcss');
  try {
    await execFileAsync(cli, ['-i', input, '-o', temporary, '--minify', '--cwd', sourceBase], {
      cwd: REPO,
    });
  } catch (error) {
    throw artifactError(app, 'css', 'Tailwind production compilation failed.', { cause: error });
  }

  const source = await readFile(temporary, 'utf8');
  const problems = [
    ...(source.length === 0 ? ['empty'] : []),
    ...(!source.includes('--ui-color-canvas') ? ['shared tokens'] : []),
    ...(!source.includes(requiredUtility) ? [`utility ${requiredUtility}`] : []),
    ...(source.includes('@source') ? ['@source directive'] : []),
    ...(source.includes('tailwind-browser') ? ['browser compiler marker'] : []),
  ];
  if (problems.length > 0) {
    const classes = [...source.matchAll(/\.([a-z][a-z0-9_-]*)/gu)]
      .slice(0, 12)
      .map((match) => match[1])
      .join(', ');
    throw artifactError(
      app,
      'css',
      `compiled stylesheet failed: ${problems.join(', ')}; classes: ${classes || 'none'}.`,
    );
  }

  const virtual = '\0production-artifact.css';
  return {
    temporary,
    plugin: /** @type {import('vite').Plugin} */ ({
      name: 'production-css',
      enforce: 'pre',
      resolveId(id) {
        return id === virtual ? virtual : null;
      },
      load(id) {
        return id === virtual ? source : null;
      },
      transform(code, id) {
        return id.split('?')[0] === entry
          ? { code: `import ${JSON.stringify(virtual)};\n${code}`, map: null }
          : null;
      },
    }),
  };
}

/**
 * Compile only one remote's class sources. Shared tokens remain available, but shell and
 * sibling application sources cannot leak utilities into this independently released CSS.
 *
 * @param {BuildApplication} app
 * @param {string} remoteDir
 * @param {string} stage
 * @param {string} entry
 */
async function productionRemoteCss(app, remoteDir, stage, entry) {
  const input = join(stage, '.remote-input.css');
  const temporary = join(stage, '.remote-production.css');
  const originalPath = join(app.dir, 'src', 'app.css');
  let source = await readFile(originalPath, 'utf8');
  source = source.replace(/^@source\s+[^;]+;\s*$/gmu, '');
  source = source.replace(/@import\s+(['"])(\.\.?\/[^'"]+)\1/gu, (_match, quote, path) => {
    const target = resolve(dirname(originalPath), String(path));
    let rewritten = relative(dirname(input), target).split(sep).join('/');
    if (!rewritten.startsWith('.')) rewritten = `./${rewritten}`;
    return `@import ${String(quote)}${rewritten}${String(quote)}`;
  });
  let tailwind = relative(
    dirname(input),
    join(REPO, 'node_modules', 'tailwindcss', 'index.css'),
  ).split(sep).join('/');
  if (!tailwind.startsWith('.')) tailwind = `./${tailwind}`;
  source = source.replace(
    /@import\s+(['"])tailwindcss\1/gu,
    (_match, quote) => `@import ${String(quote)}${tailwind}${String(quote)}`,
  );
  const remoteSource = remoteDir.split(sep).join('/');
  source += `\n@source '${remoteSource}';\n`;
  await writeFile(input, source);
  const compiled = await compileProductionCss(
    app,
    input,
    temporary,
    entry,
    '.text-muted',
    remoteDir,
  );
  return { ...compiled, input };
}

/**
 * Vite extracts JavaScript dependency notices. Tailwind enters through its CLI rather
 * than the JavaScript graph, so its full notice is added from the exact pinned package.
 *
 * @param {string} stage
 * @param {string} publicDir
 */
async function emitLicenses(stage, publicDir) {
  const generated = join(publicDir, 'THIRD_PARTY_LICENSES.md');
  const javascript = (await readFile(generated, 'utf8')).trimEnd();
  const tailwindPackage = JSON.parse(
    await readFile(join(REPO, 'node_modules', 'tailwindcss', 'package.json'), 'utf8'),
  );
  const tailwind = (await readFile(join(REPO, 'node_modules', 'tailwindcss', 'LICENSE'), 'utf8')).trim();
  const source =
    `${javascript}\n\n## tailwindcss - ${String(tailwindPackage.version)} ` +
    `(${String(tailwindPackage.license)})\n\n${tailwind}\n`;
  await writeFile(join(stage, 'THIRD_PARTY_LICENSES.md'), source);
  await rm(generated);
}

/**
 * Let Vite consume the real application HTML after removing source-delivery-only nodes.
 * parse5 owns HTML syntax; this code owns only which application facts survive production.
 * Shared source-delivery facts are counted exactly. Application-specific duplicated nodes
 * opt out with `data-artifact="source-only"`, so this module never learns their contents.
 *
 * @param {BuildApplication} app
 * @returns {import('vite').Plugin}
 */
function productionHtml(app) {
  return {
    name: 'production-html',
    transformIndexHtml: {
      order: 'pre',
      handler(source) {
        const document = /** @type {HtmlNode} */ (/** @type {unknown} */ (parse(source)));
        const removed = {
          theme: 0,
          themePalette: 0,
          importMap: 0,
          tailwind: 0,
          tailwindInput: 0,
        };
        let entry = 0;
        let root = 0;
        let noscript = 0;

        visitHtml(document, (node) => {
          if (node.tagName === 'script' && htmlAttribute(node, 'type') === 'module') {
            if (htmlAttribute(node, 'src') === '/src/main.js') entry += 1;
          }
          if (node.tagName === 'app-root') root += 1;
          if (node.tagName === 'noscript') noscript += 1;
        });
        pruneHtml(document, (node) => {
          if (node.nodeName === '#comment') return true;
          if (htmlAttribute(node, 'data-artifact') === 'source-only') return true;
          if (node.tagName === 'link' && htmlAttribute(node, 'href') === '/components/theme.css') {
            removed.theme += 1;
            return true;
          }
          // The palette is a second link and a second fact: the compiled stylesheet
          // carries both sheets, so an artifact that still asks the origin for one of
          // them is a request that will 404 in the deployed shape.
          if (
            node.tagName === 'link' &&
            htmlAttribute(node, 'href') === '/components/theme-default.css'
          ) {
            removed.themePalette += 1;
            return true;
          }
          if (node.tagName === 'script' && htmlAttribute(node, 'type') === 'importmap') {
            removed.importMap += 1;
            return true;
          }
          if (
            node.tagName === 'script' &&
            htmlAttribute(node, 'src') === '/lib/vendor/tailwind-browser.js'
          ) {
            removed.tailwind += 1;
            return true;
          }
          if (node.tagName === 'style' && htmlAttribute(node, 'type') === 'text/tailwindcss') {
            removed.tailwindInput += 1;
            return true;
          }
          return false;
        });

        const facts = { ...removed, entry, root, noscript };
        const drift = Object.entries(facts).filter(([, count]) => count !== 1);
        if (drift.length > 0) {
          throw artifactError(
            app,
            'html',
            `expected one of each production HTML fact; saw ${drift
              .map(([name, count]) => `${name}=${String(count)}`)
              .join(', ')}.`,
          );
        }
        return {
          html: serialize(/** @type {never} */ (document)),
          tags: [
            {
              tag: 'link',
              attrs: { rel: 'icon', href: 'data:,' },
              injectTo: 'head',
            },
          ],
        };
      },
    },
  };
}

/**
 * @typedef {{ nodeName: string, tagName?: string, attrs?: Array<{ name: string, value: string }>, childNodes?: HtmlNode[], value?: string }} HtmlNode
 */

/**
 * @param {HtmlNode} node
 * @param {(node: HtmlNode) => void} visit
 */
function visitHtml(node, visit) {
  visit(node);
  for (const child of node.childNodes ?? []) visitHtml(child, visit);
}

/**
 * @param {HtmlNode} node
 * @param {(node: HtmlNode) => boolean} remove
 */
function pruneHtml(node, remove) {
  if (node.childNodes === undefined) return;
  node.childNodes = node.childNodes.filter((child) => !remove(child));
  for (const child of node.childNodes) pruneHtml(child, remove);
}

/**
 * @param {HtmlNode} node
 * @param {string} name
 */
function htmlAttribute(node, name) {
  return node.attrs?.find((attribute) => attribute.name === name)?.value;
}

/**
 * Copy only runtime data admitted by the rewritten manifest and emit stable release
 * identity. Locale URLs remain stable and revalidated until a runtime mapping exists.
 *
 * @param {BuildApplication} app
 * @param {string} publicDir
 * @param {{ commit: string | null, sourceDateEpoch: number | null }} release
 * @param {import('../../source/lib/core/remotes/types.js').AppManifest} admitted
 */
async function emitRuntimeData(app, publicDir, release, admitted) {
  const copied = new Set();
  for (const locale of admitted.i18n.supportedLocales) {
    for (const pattern of admitted.i18n.bundles) {
      const url = pattern.replaceAll('{locale}', locale);
      if (copied.has(url)) continue;
      const source = await readFile(urlToFile(app.dir, url), 'utf8');
      JSON.parse(source);
      const destination = join(publicDir, url);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, source);
      copied.add(url);
    }
  }
  if (copied.size === 0) {
    throw artifactError(app, 'runtime', 'admitted manifest names no locale data.');
  }

  const build = { version: 1, app: app.name, release, target: TARGET };
  await writeFile(join(publicDir, 'build.json'), `${JSON.stringify(build, null, 2)}\n`);
}

/**
 * Bind every emitted module URL to its exact bytes through import-map integrity and
 * return the exact CSP header that admits the generated inline map.
 *
 * @param {BuildApplication} app
 * @param {string} publicDir
 * @param {ReturnType<typeof chunkRelationships>} chunks
 * @param {Record<string, string>} imports
 * @param {Array<{ url: string, integrity: string }>} remoteModules
 */
async function emitSecurity(app, publicDir, chunks, imports, remoteModules) {
  /** @type {Record<string, string>} */
  const integrity = {};
  for (const chunk of chunks) {
    const bytes = await readFile(join(publicDir, chunk.path));
    integrity[`/${chunk.path}`] = `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
  }
  for (const remote of remoteModules) {
    if (integrity[remote.url] !== undefined && integrity[remote.url] !== remote.integrity) {
      throw artifactError(app, 'security', `two module assets claim ${remote.url}.`);
    }
    integrity[remote.url] = remote.integrity;
  }
  if (Object.keys(integrity).length === 0) {
    throw artifactError(app, 'security', 'generated module graph is empty.');
  }

  const importMap = JSON.stringify({ imports, integrity });
  const inlineHash = importMapHash(importMap);
  const htmlPath = join(publicDir, 'index.html');
  const document = /** @type {HtmlNode} */ (
    /** @type {unknown} */ (parse(await readFile(htmlPath, 'utf8')))
  );
  /** @type {HtmlNode[]} */
  const heads = [];
  visitHtml(document, (node) => {
    if (node.tagName === 'head') heads.push(node);
  });
  const head = heads[0];
  if (heads.length !== 1 || head?.childNodes === undefined) {
    throw artifactError(app, 'security', `production HTML has ${String(heads.length)} head elements.`);
  }
  const entryIndex = head.childNodes.findIndex(
    (node) => node.tagName === 'script' && htmlAttribute(node, 'type') === 'module',
  );
  if (entryIndex === -1) {
    throw artifactError(app, 'security', 'production HTML has no module entry for integrity map.');
  }
  const fragment = /** @type {HtmlNode} */ (
    /** @type {unknown} */ (parseFragment(`<script type="importmap">${importMap}</script>`))
  );
  const script = fragment.childNodes?.[0];
  if (script === undefined) {
    throw artifactError(app, 'security', 'could not construct integrity import map.');
  }
  head.childNodes.splice(entryIndex, 0, script);
  const html = serialize(/** @type {never} */ (document));
  await writeFile(htmlPath, html);

  return {
    importMap: { source: importMap, sha256: inlineHash },
    modules: Object.entries(integrity).map(([path, value]) => ({ path, integrity: value })),
    csp: cspForImportMap(inlineHash),
  };
}

/** @param {string} source */
function importMapHash(source) {
  return `sha256-${createHash('sha256').update(source, 'utf8').digest('base64')}`;
}

/** @param {string} inlineHash */
function cspForImportMap(inlineHash) {
  return (
    `default-src 'self'; script-src 'self' '${inlineHash}'; ` +
    `style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; ` +
    `object-src 'none'; base-uri 'none'; frame-ancestors 'none'; ` +
    `trusted-types lit-html ui-test ui-test-template; require-trusted-types-for 'script'`
  );
}

/** @param {BuildApplication} app @param {string} source @param {string} importMap */
function replaceImportMap(app, source, importMap) {
  const document = /** @type {HtmlNode} */ (/** @type {unknown} */ (parse(source)));
  /** @type {HtmlNode[]} */
  const scripts = [];
  visitHtml(document, (node) => {
    if (node.tagName === 'script' && htmlAttribute(node, 'type') === 'importmap') {
      scripts.push(node);
    }
  });
  const script = scripts[0];
  const text = script?.childNodes?.[0];
  if (
    scripts.length !== 1 ||
    script?.childNodes?.length !== 1 ||
    text?.nodeName !== '#text' ||
    typeof text.value !== 'string'
  ) {
    throw artifactError(
      app,
      'compose',
      `production HTML has ${String(scripts.length)} writable integrity import maps.`,
    );
  }
  text.value = importMap;
  return serialize(/** @type {never} */ (document));
}

/**
 * @param {BuildApplication} app
 * @param {string} publicDir
 */
async function verifyBrowserRoot(app, publicDir) {
  const html = await readFile(join(publicDir, 'index.html'), 'utf8');
  const forbidden = [
    'tailwind-browser',
    'text/tailwindcss',
    'data-artifact=',
    '/src/',
    '/lib/',
    '/components/theme.css',
    '/components/theme-default.css',
  ].filter((marker) => html.includes(marker));
  if (forbidden.length > 0) {
    throw artifactError(app, 'verify', `production HTML retains ${forbidden.join(', ')}.`);
  }
  if (!html.includes('<app-root></app-root>') || !html.includes('<noscript')) {
    throw artifactError(app, 'verify', 'production HTML lost root or noscript markup.');
  }
  if ((html.match(/type="importmap"/gu) ?? []).length !== 1) {
    throw artifactError(app, 'verify', 'production HTML must contain one integrity import map.');
  }

  const cssPaths = (await walk(publicDir, /\.css$/u)).sort();
  if (cssPaths.length !== 1) {
    throw artifactError(app, 'verify', `expected one production stylesheet; saw ${String(cssPaths.length)}.`);
  }
  const cssPath = cssPaths[0];
  if (cssPath === undefined) return;
  const relativeCss = relative(publicDir, cssPath).split(sep).join('/');
  if (!/^assets\/[a-z0-9_-]+-[A-Za-z0-9_-]{8}\.css$/u.test(relativeCss)) {
    throw artifactError(app, 'verify', `production stylesheet is not hash-named: ${relativeCss}`);
  }
  if (!html.includes(`/${relativeCss}`) && !html.includes(`./${relativeCss}`)) {
    throw artifactError(app, 'verify', `production HTML does not load ${relativeCss}.`);
  }
  const css = await readFile(cssPath, 'utf8');
  if (!css.includes('--ui-color-canvas') || css.includes('@source') || css.includes('@import')) {
    throw artifactError(app, 'verify', 'production stylesheet lost tokens or retains build directives.');
  }
}

/**
 * Inject explicit built template URLs into every bundled `defineComponent` call. Source
 * stays untouched; only Vite's in-memory module text changes. TypeScript AST ranges make
 * object formatting irrelevant and keep strings or comments containing the same words
 * out of the transform.
 *
 * @param {BuildApplication} app
 * @param {import('../project-model/types.js').ProjectModel} model
 * @param {string} base
 */
function templateTransform(app, model, base) {
  /** @type {Map<string, import('../project-model/types.js').ElementRecord[]>} */
  const byModule = new Map();
  for (const record of model.elements.values()) {
    if (record.kind !== 'defineComponent' || record.template === null) continue;
    const records = byModule.get(record.module) ?? [];
    records.push(record);
    byModule.set(record.module, records);
  }

  /** @type {Map<string, TemplateAsset>} */
  const used = new Map();

  return {
    plugin: /** @type {import('vite').Plugin} */ ({
      name: 'production-template-identity',
      enforce: 'pre',
      async transform(code, id) {
        const module = id.split('?')[0] ?? id;
        const records = byModule.get(module);
        if (records === undefined || records.length === 0) return null;

        const tree = ts.createSourceFile(
          module,
          code,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.JS,
        );
        /** @type {Map<string, ts.ObjectLiteralExpression[]>} */
        const definitions = new Map();

        /** @param {ts.Node} node */
        const visit = (node) => {
          if (ts.isCallExpression(node) && calledName(node.expression) === 'defineComponent') {
            const object = node.arguments[0];
            if (object !== undefined && ts.isObjectLiteralExpression(object)) {
              const tag = literalProperty(object, 'tag');
              if (tag !== null) {
                const found = definitions.get(tag) ?? [];
                found.push(object);
                definitions.set(tag, found);
              }
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(tree);

        /** @type {Array<{ start: number, end: number, text: string }>} */
        const edits = [];
        for (const record of records) {
          const matches = definitions.get(record.tag) ?? [];
          if (matches.length !== 1) {
            throw artifactError(
              app,
              'templates',
              `${relative(REPO, module)} maps <${record.tag}> to ${String(matches.length)} ` +
                'statically readable defineComponent calls; expected exactly one.',
            );
          }
          if (record.templateExists !== true) {
            throw artifactError(
              app,
              'templates',
              `<${record.tag}> names missing template ${relative(REPO, record.template ?? '')}.`,
            );
          }

          const asset = await templateAsset(record, base);
          const definition = matches[0];
          if (definition === undefined) continue;
          const existing = propertyAssignment(definition, 'template');
          if (existing === null) {
            edits.push({
              start: definition.getStart(tree) + 1,
              end: definition.getStart(tree) + 1,
              text: `template: ${JSON.stringify(asset.url)}, `,
            });
          } else {
            edits.push({
              start: existing.initializer.getStart(tree),
              end: existing.initializer.getEnd(),
              text: JSON.stringify(asset.url),
            });
          }

          const collision = used.get(asset.url);
          if (collision !== undefined && collision.source !== asset.source) {
            throw artifactError(
              app,
              'templates',
              `${asset.url} maps both <${collision.tag}> and <${asset.tag}> to different bytes.`,
            );
          }
          used.set(asset.url, asset);
        }

        let transformed = code;
        for (const edit of edits.sort((left, right) => right.start - left.start)) {
          transformed = transformed.slice(0, edit.start) + edit.text + transformed.slice(edit.end);
        }
        return { code: transformed, map: null };
      },
    }),
    assets: () => [...used.values()].sort((left, right) => left.url.localeCompare(right.url)),
  };
}

/**
 * @param {import('../project-model/types.js').ElementRecord} record
 * @param {string} base
 * @returns {Promise<TemplateAsset>}
 */
async function templateAsset(record, base) {
  const template = String(record.template);
  const source = await readFile(template, 'utf8');
  const hash = createHash('sha256').update(source, 'utf8').digest('hex').slice(0, 16);
  const path = `assets/templates/${record.tag}-${hash}.html`;
  return { tag: record.tag, module: record.module, template, url: `${base}${path}`, path, source };
}

/**
 * Emit fallback markup, one bundle keyed by those final URLs, and the admitted runtime
 * manifest that points at it. Reading the emitted bytes back before publication makes a
 * stale or malformed bundle a build failure rather than a blank route.
 *
 * @param {BuildApplication} app
 * @param {string} stage
 * @param {TemplateAsset[]} assets
 * @param {string} base
 */
async function emitTemplateFiles(app, stage, assets, base) {
  if (assets.length === 0) {
    throw artifactError(app, 'templates', 'bundled graph contains no component templates.');
  }

  /** @type {Record<string, string>} */
  const bundle = {};
  for (const asset of assets) {
    await mkdir(dirname(join(stage, asset.path)), { recursive: true });
    await writeFile(join(stage, asset.path), asset.source);
    bundle[asset.url] = asset.source;
  }

  const bundleSource = `${JSON.stringify(bundle)}\n`;
  const bundleHash = createHash('sha256').update(bundleSource, 'utf8').digest('hex').slice(0, 16);
  const bundlePath = `assets/templates-${bundleHash}.json`;
  await writeFile(join(stage, bundlePath), bundleSource);

  const emitted = JSON.parse(await readFile(join(stage, bundlePath), 'utf8'));
  for (const asset of assets) {
    if (emitted[asset.url] !== asset.source) {
      throw artifactError(app, 'templates', `template bundle bytes drifted for <${asset.tag}>.`);
    }
    if ((await readFile(join(stage, asset.path), 'utf8')) !== asset.source) {
      throw artifactError(app, 'templates', `fallback bytes drifted for <${asset.tag}>.`);
    }
  }
  if (Object.keys(emitted).length !== assets.length) {
    throw artifactError(
      app,
      'templates',
      `template bundle has ${String(Object.keys(emitted).length)} keys for ` +
        `${String(assets.length)} transformed definitions.`,
    );
  }

  return {
    bundle: bundlePath,
    url: `${base}${bundlePath}`,
    count: assets.length,
    fallbacks: assets.map((asset) => asset.path),
  };
}

/**
 * @param {ts.LeftHandSideExpression} expression
 * @returns {string | null}
 */
function calledName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    const owner = calledName(expression.expression);
    return owner === null ? expression.name.text : `${owner}.${expression.name.text}`;
  }
  return null;
}

/**
 * @param {ts.ObjectLiteralExpression} object
 * @param {string} name
 */
function propertyAssignment(object, name) {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const propertyName = ts.isIdentifier(property.name)
      ? property.name.text
      : ts.isStringLiteralLike(property.name)
        ? property.name.text
        : null;
    if (propertyName === name) return property;
  }
  return null;
}

/**
 * @param {ts.ObjectLiteralExpression} object
 * @param {string} name
 */
function literalProperty(object, name) {
  const property = propertyAssignment(object, name);
  return property !== null && ts.isStringLiteralLike(property.initializer)
    ? property.initializer.text.toLowerCase()
    : null;
}

/**
 * Resolve source prefixes from the application import map and admit only bare imports
 * already declared there. Bare dependencies then resolve from the exact local npm
 * versions; no build-time network resolver exists.
 *
 * @param {BuildApplication} app
 * @param {Record<string, string>} prefixes
 * @returns {Promise<import('vite').Plugin>}
 */
async function importMapResolver(app, prefixes) {
  const html = await readText(join(app.dir, 'index.html'));
  const { imports } = extractImportMap(html, `${app.name}/index.html`);
  const bare = new Set(
    Object.keys(imports).filter((specifier) => !specifier.startsWith('/') && !specifier.endsWith('/')),
  );
  const orderedPrefixes = Object.entries(prefixes).sort(
    ([left], [right]) => right.length - left.length,
  );

  return {
    name: 'repository-import-map',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source.startsWith('\0')) return null;
      if (source === REPO || source.startsWith(`${REPO}${sep}`)) return source;
      if (importer?.includes(`${sep}node_modules${sep}`) === true) return null;
      if (/^(?:https?:)?\/\//u.test(source)) {
        throw artifactError(app, 'resolve', `network module is forbidden: ${source}`);
      }
      for (const [prefix, directory] of orderedPrefixes) {
        if (source.startsWith(prefix)) return join(directory, source.slice(prefix.length));
      }
      if (source.startsWith('/')) return urlToFile(app.dir, source);
      if (isBare(source) && !bare.has(source)) {
        throw artifactError(
          app,
          'resolve',
          `bare import is absent from ${app.name}/index.html: ${source}`,
        );
      }
      return null;
    },
  };
}

/** @param {string} specifier */
function isBare(specifier) {
  return !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('\0');
}

/**
 * @param {BuildApplication} app
 */
function validateApp(app) {
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(app.name)) {
    throw artifactError(app, 'input', `invalid application name: ${app.name}`);
  }
  const inside = relative(REPO, resolve(app.dir));
  if (inside.startsWith(`..${sep}`) || inside === '..' || inside === '') {
    throw artifactError(app, 'input', 'application directory must be inside repository root.');
  }
}

/**
 * Repository output is allowed only below dist/. Explicit temporary output outside the
 * repository is also safe. This keeps cleanup away from source even with a bad caller.
 *
 * @param {string} outDir
 * @param {BuildApplication} app
 */
function validateOutput(outDir, app) {
  const output = resolve(outDir);
  const insideRepo = relative(REPO, output);
  const insideDist = relative(DIST, output);
  const inRepository = insideRepo !== '..' && !insideRepo.startsWith(`..${sep}`);
  const belowDist = insideDist !== '' && insideDist !== '..' && !insideDist.startsWith(`..${sep}`);

  if (inRepository && !belowDist) {
    throw artifactError(
      app,
      'output',
      `${output} is inside repository source; use dist/<app> or an external temporary directory.`,
    );
  }
  return output;
}

/**
 * @param {ReleaseInput} release
 * @param {BuildApplication} app
 */
function normalizeRelease(release, app) {
  const commit = release.commit ?? null;
  const sourceDateEpoch = release.sourceDateEpoch ?? null;
  if (commit !== null && !/^[0-9a-f]{7,64}$/u.test(commit)) {
    throw artifactError(app, 'release', `invalid git commit: ${commit}`);
  }
  if (sourceDateEpoch !== null && (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch < 0)) {
    throw artifactError(
      app,
      'release',
      `SOURCE_DATE_EPOCH must be a non-negative integer: ${String(sourceDateEpoch)}`,
    );
  }
  return { commit, sourceDateEpoch };
}

/**
 * Reduce the engine's output graph to stable artifact facts. Absolute module paths are
 * converted to repository-relative names before they cross the build interface.
 *
 * @param {BuildApplication} app
 * @param {Awaited<ReturnType<typeof viteBuild>>} output
 */
function chunkRelationships(app, output) {
  const builds = Array.isArray(output) ? output : [output];
  const chunks = [];

  for (const build of builds) {
    if (!('output' in build)) {
      throw artifactError(app, 'verify', 'build engine returned a watcher instead of output.');
    }
    for (const item of build.output) {
      if (item.type !== 'chunk') continue;
      chunks.push({
        path: item.fileName,
        entry: item.isEntry,
        dynamicEntry: item.isDynamicEntry,
        facade:
          item.facadeModuleId === null ? null : portableModule(app, item.facadeModuleId),
        imports: [...item.imports].sort((left, right) => left.localeCompare(right)),
        dynamicImports: [...item.dynamicImports].sort((left, right) => left.localeCompare(right)),
        modules: Object.keys(item.modules)
          .map((module) => portableModule(app, module))
          .sort((left, right) => left.localeCompare(right)),
      });
    }
  }

  return chunks.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * @param {BuildApplication} app
 * @param {string} module
 */
function portableModule(app, module) {
  if (module.startsWith('\0')) return module;
  const clean = module.split('?')[0] ?? module;
  const path = relative(REPO, clean);
  if (path === '..' || path.startsWith(`..${sep}`)) {
    throw artifactError(app, 'verify', `generated chunk contains module outside repository: ${module}`);
  }
  return path.split(sep).join('/');
}

/**
 * @param {string} directory
 */
async function inventory(directory) {
  const paths = (await walk(directory, /./u)).sort((left, right) => left.localeCompare(right));
  return Promise.all(
    paths.map(async (path) => {
      const bytes = await readFile(path);
      return {
        path: relative(directory, path).split(sep).join('/'),
        cache: cacheClass(relative(directory, path).split(sep).join('/')),
        bytes: bytes.byteLength,
        gzip: gzipSync(bytes, { level: 9 }).byteLength,
        brotli: brotliCompressSync(bytes).byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    }),
  );
}

/** @param {string} path */
function cacheClass(path) {
  if (path === 'THIRD_PARTY_LICENSES.md') return 'metadata';
  if (/^public\/assets\/(?:[^/]+\/)*[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/u.test(path)) {
    return 'immutable';
  }
  if (
    path === 'public/index.html' ||
    path === 'public/app.manifest.json' ||
    path === 'public/build.json' ||
    /^public\/i18n\/[a-z0-9-]+\.json$/u.test(path)
  ) {
    return 'revalidate';
  }
  return 'unknown';
}

/**
 * @param {BuildApplication} app
 * @param {Awaited<ReturnType<typeof inventory>>} files
 * @param {Awaited<ReturnType<typeof emitTemplateFiles>>} templates
 * @param {ReturnType<typeof chunkRelationships>} chunks
 */
function verifyPayload(app, files, templates, chunks) {
  const javascript = files.filter((file) => file.path.endsWith('.js'));
  if (javascript.length < 2) {
    throw artifactError(app, 'verify', 'expected entry and lazy JavaScript chunks.');
  }
  for (const file of javascript) {
    if (!HASHED_JAVASCRIPT.test(file.path)) {
      throw artifactError(app, 'verify', `JavaScript chunk is not hash-named: ${file.path}`);
    }
  }
  if (files.some((file) => file.path.endsWith('.map'))) {
    throw artifactError(app, 'verify', 'public source map emitted.');
  }
  if (!files.some((file) => file.path === 'THIRD_PARTY_LICENSES.md')) {
    throw artifactError(app, 'verify', 'THIRD_PARTY_LICENSES.md was not emitted.');
  }
  const javascriptPaths = new Set(
    javascript.map((file) => file.path.replace(/^public\//u, '')),
  );
  if (chunks.length !== javascript.length) {
    throw artifactError(
      app,
      'verify',
      `build graph has ${String(chunks.length)} chunks for ${String(javascript.length)} JavaScript files.`,
    );
  }
  for (const chunk of chunks) {
    if (!javascriptPaths.has(chunk.path)) {
      throw artifactError(app, 'verify', `build graph names missing chunk: ${chunk.path}`);
    }
    for (const imported of [...chunk.imports, ...chunk.dynamicImports]) {
      if (!javascriptPaths.has(imported)) {
        throw artifactError(app, 'verify', `${chunk.path} imports unreported chunk ${imported}.`);
      }
    }
    const forbiddenModules = chunk.modules.filter((module) => forbiddenSourceModule(app, module));
    if (forbiddenModules.length > 0) {
      throw artifactError(
        app,
        'verify',
        `${chunk.path} includes forbidden production module ${forbiddenModules.join(', ')}.`,
      );
    }
  }
  if (!/assets\/templates-[0-9a-f]{16}\.json$/u.test(templates.bundle)) {
    throw artifactError(app, 'verify', `template bundle is not hash-named: ${templates.bundle}`);
  }
  const fileByPath = new Map(files.map((file) => [file.path, file]));
  verifyHexHash(
    app,
    fileByPath,
    `${PUBLIC}/${templates.bundle}`,
    /templates-([0-9a-f]{16})\.json$/u,
  );
  for (const fallback of templates.fallbacks) {
    if (!/^assets\/templates\/[a-z0-9-]+-[0-9a-f]{16}\.html$/u.test(fallback)) {
      throw artifactError(app, 'verify', `template fallback is not hash-named: ${fallback}`);
    }
    verifyHexHash(app, fileByPath, `${PUBLIC}/${fallback}`, /-([0-9a-f]{16})\.html$/u);
  }

  const unknown = files.filter((file) => file.cache === 'unknown').map((file) => file.path);
  if (unknown.length > 0) {
    throw artifactError(app, 'verify', `output is outside the artifact allowlist: ${unknown.join(', ')}`);
  }
  const forbiddenFiles = files
    .map((file) => file.path)
    .filter((path) =>
      /(?:^|\/)(?:test|server|data|import|\.private)(?:\/|$)|\.(?:db|sqlite|map)$/u.test(path),
    );
  if (forbiddenFiles.length > 0) {
    throw artifactError(app, 'verify', `output contains forbidden path: ${forbiddenFiles.join(', ')}`);
  }
  const required = [
    'THIRD_PARTY_LICENSES.md',
    `${PUBLIC}/index.html`,
    `${PUBLIC}/app.manifest.json`,
    `${PUBLIC}/build.json`,
  ];
  for (const path of required) {
    if (!fileByPath.has(path)) throw artifactError(app, 'verify', `required output is missing: ${path}`);
  }
}

/** @param {BuildApplication} app @param {string} module */
function forbiddenSourceModule(app, module) {
  if (/(?:^|\/)(?:test|\.private)(?:\/|$)/u.test(module)) return true;
  return ['server', 'data', 'import'].some(
    (directory) =>
      module === `${app.name}/${directory}` || module.startsWith(`${app.name}/${directory}/`),
  );
}

/**
 * @param {BuildApplication} app
 * @param {Map<string, Awaited<ReturnType<typeof inventory>>[number]>} files
 * @param {string} path
 * @param {RegExp} pattern
 */
function verifyHexHash(app, files, path, pattern) {
  const file = files.get(path);
  const named = pattern.exec(path)?.[1];
  if (file === undefined || named === undefined || !file.sha256.startsWith(named)) {
    throw artifactError(app, 'verify', `content hash does not match emitted bytes: ${path}`);
  }
}

/**
 * Rename verified output into place. Existing output moves aside until publication
 * succeeds, so build failure cannot erase its last valid artifact.
 *
 * @param {string} stage
 * @param {string} output
 * @param {BuildApplication} app
 */
async function publish(stage, output, app) {
  const backup = `${output}.previous`;
  const abandonedBackup = await exists(backup);
  let hadOutput = await exists(output);
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
    throw artifactError(app, 'publish', `could not atomically replace ${output}`, { cause: error });
  }
  await rm(backup, { recursive: true, force: true });
}

/** @param {string} path */
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * @template T
 * @param {T} value
 * @returns {Readonly<T>}
 */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

/**
 * @param {BuildApplication} app
 * @param {string} phase
 * @param {string} detail
 * @param {ErrorOptions} [options]
 */
function artifactError(app, phase, detail, options) {
  return new Error(`artifact:${app.name}:${phase}: ${detail}`, options);
}

/** @returns {Promise<ReleaseInput>} */
async function releaseFromEnvironment() {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: REPO });
  const rawEpoch = process.env.SOURCE_DATE_EPOCH;
  if (rawEpoch !== undefined && !/^\d+$/u.test(rawEpoch)) {
    throw new Error(`SOURCE_DATE_EPOCH must be a non-negative integer: ${rawEpoch}`);
  }
  return {
    commit: stdout.trim(),
    sourceDateEpoch: rawEpoch === undefined ? null : Number(rawEpoch),
  };
}

/* Guarded CLI adapter. Shell and Remote builds cross separate interfaces. */
if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  try {
    const app = await selectedApp();
    const release = await releaseFromEnvironment();
    const outputIndex = process.argv.indexOf('--out');
    const output = outputIndex === -1 ? undefined : process.argv[outputIndex + 1];
    if (outputIndex !== -1 && output === undefined) {
      throw new Error('usage: npm run build -- --app <app> [--remote <name>] [--out <directory>]');
    }
    const remoteIndex = process.argv.indexOf('--remote');
    const remoteName = remoteIndex === -1 ? undefined : process.argv[remoteIndex + 1];
    if (remoteIndex !== -1 && remoteName === undefined) {
      throw new Error('usage: npm run build -- --app <app> --remote <name> [--out <directory>]');
    }
    const baseIndex = process.argv.indexOf('--base');
    const base = baseIndex === -1 ? undefined : process.argv[baseIndex + 1];
    if (baseIndex !== -1 && base === undefined) {
      throw new Error('usage: --base /remotes/<name>/<version>/');
    }
    const remoteReports = [];
    for (const [index, argument] of process.argv.entries()) {
      if (argument !== '--remote-report') continue;
      const path = process.argv[index + 1];
      if (path === undefined) throw new Error('usage: --remote-report <artifact.json>');
      const report = JSON.parse(await readFile(resolve(path), 'utf8'));
      remoteReports.push({ ...report, root: dirname(resolve(path)) });
    }
    const composeIndex = process.argv.indexOf('--compose-from');
    const composeFrom = composeIndex === -1 ? undefined : process.argv[composeIndex + 1];
    if (composeIndex !== -1 && (composeFrom === undefined || output === undefined)) {
      throw new Error(
        'usage: npm run build -- --app <app> --compose-from <shell-artifact> --out <directory> --remote-report <release.json> ...',
      );
    }
    if (composeFrom !== undefined && remoteName !== undefined) {
      throw new Error('--compose-from cannot be combined with --remote.');
    }
    const report =
      composeFrom !== undefined
        ? await composeArtifact({
            app,
            artifactRoot: composeFrom,
            outDir: String(output),
            remotes: remoteReports,
          })
        : remoteName === undefined
        ? await buildArtifact({ app, outDir: output, release, remotes: remoteReports })
        : await buildRemoteArtifact({ app, name: remoteName, outDir: output, base, release });
    const totals = /** @type {{ files: number, bytes: number, gzip: number, brotli: number }} */ (
      report.totals
    );
    console.log(
      `${app.name}${remoteName === undefined ? '' : `/${remoteName}`}: ` +
        `${String(totals.files)} payload files, ${String(totals.bytes)} B raw, ` +
        `${String(totals.gzip)} B gzip, ${String(totals.brotli)} B Brotli -> ${String(report.root)}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
