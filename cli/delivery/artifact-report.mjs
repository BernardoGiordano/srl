/**
 * The artifact report: one name, one shape, one module that writes and reads it.
 *
 * `artifact.json` is the central value of the delivery pipeline. It is what the
 * build produces beside the bytes, what a release is prepared from, what a live
 * origin is verified against and what the benchmark measures. It used to be
 * declared `Promise<Readonly<Record<string, unknown>>>`, which is to say it was
 * not declared at all: the build re-read its own output through five poke-helpers
 * — `recordValue`, `arrayValue`, `stringValue`, `stringArray`, `artifactRecord` —
 * and each of the five downstream tools wrote its own `report.version !== 1 || …`
 * over the same document, checking a different subset of it.
 *
 * Six hand-rolled validations of a shape this repository writes. This module is
 * the name that was missing. `writeReport` is the only thing that writes one and
 * `readReport` the only thing that reads one, so a field added here reaches every
 * consumer as a typed property rather than as a cast at six call sites.
 *
 * `parseReport` is pure — bytes in, `ArtifactReport` out — which is what makes the
 * contract testable without running Vite over a real application. ADR-0074.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** @import { AppManifest, RemoteDescriptor } from '@srljs/core/lib/core/remotes/types.js' */

/**
 * The report's own file name, at the root of every artifact this toolchain builds.
 * It is metadata rather than payload: a release copies it, and no browser fetches it.
 */
export const REPORT = 'artifact.json';

/**
 * The one directory inside an artifact a web server is pointed at. Everything else
 * an artifact carries — the report, the licence file — stays behind the origin.
 */
export const PUBLIC = 'public';

/** How long a served file may be cached, by class. `metadata` is never served. */
const CACHE_CLASSES = new Set(['immutable', 'revalidate', 'metadata']);

/** How templates reach the browser. ADR-0071, ADR-0081. */
const DELIVERIES = new Set(['split', 'split-lazy', 'bundle']);

const NAME = /^[a-z0-9][a-z0-9._-]*$/u;
const COMMIT = /^[0-9a-f]{7,64}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const INLINE_HASH = /^sha256-[A-Za-z0-9+/]+={0,2}$/u;

/**
 * @typedef {'immutable' | 'revalidate' | 'metadata'} CacheClass
 * @typedef {'split' | 'split-lazy' | 'bundle'} TemplateDelivery
 *
 * One file in the artifact, hashed and measured as it was written.
 * @typedef {{ path: string, cache: CacheClass, bytes: number, gzip: number, brotli: number, sha256: string }} ArtifactFile
 *
 * The inventory, added up. The benchmark's budgets are written against these.
 * @typedef {{ files: number, bytes: number, gzip: number, brotli: number }} ArtifactTotals
 *
 * One emitted JavaScript chunk and the graph edges that produced it.
 * @typedef {{ path: string, entry: boolean, dynamicEntry: boolean, facade: string | null, imports: string[], dynamicImports: string[], modules: string[] }} ArtifactChunk
 *
 * How many round trips deep the entry's static module graph is, and one chain that
 * reaches that depth. Derived from `chunks[].imports`; see `entryChain`.
 * @typedef {{ depth: number, path: string[] }} ArtifactChain
 *
 * What became of the application's templates. `bundle` and `url` are null under
 * `split` delivery, where each template is its own immutable file.
 * @typedef {{ delivery: TemplateDelivery, bundle: string | null, url: string | null, count: number, bytes: number, files: string[] }} ArtifactTemplates
 *
 * The identity the artifact was built from. Both halves are null when the build was
 * not told one: a working build of an uncommitted tree is a legitimate artifact, and
 * it is the release that refuses to ship one, not the build that refuses to make it.
 * @typedef {{ commit: string | null, sourceDateEpoch: number | null }} ArtifactRelease
 *
 * The `Cache-Control` header each class is served with. `metadata` is null
 * because nothing serves it.
 * @typedef {{ immutable: string, revalidate: string, metadata: string | null }} ArtifactCache
 *
 * Everything a host has to send for the page to be admitted by its own policy:
 * the import map as it appears in the document, its inline hash, the SRI digest
 * of every module the map pins, and the CSP that admits exactly those.
 * @typedef {{ importMap: { source: string, sha256: string }, modules: Array<{ path: string, integrity: string }>, csp: string }} ArtifactSecurity
 *
 * What a Remote publishes about itself: the transport half of a manifest entry,
 * and the same declaration the runtime admits rather than a second copy of it.
 * Access policy — mount, what the Remote requires, what it is granted — stays in
 * the shell's manifest and is never read from a Remote's own report, which is why
 * those three are the fields removed here.
 * @typedef {Omit<RemoteDescriptor, 'mount' | 'requires' | 'grants'>} RemoteTransport
 */

/**
 * The facts both artifact reports carry.
 *
 * @typedef {{
 *   version: 1,
 *   experimental?: boolean,
 *   root: string,
 *   public: string,
 *   app: string,
 *   release: ArtifactRelease,
 *   target: string,
 *   cache: ArtifactCache,
 *   entry: string,
 *   chunks: ArtifactChunk[],
 *   chain: ArtifactChain,
 *   templates: ArtifactTemplates | null,
 *   files: ArtifactFile[],
 *   totals: ArtifactTotals,
 * }} ArtifactReportBase
 */

/**
 * A shell artifact: the document, its import map, its security metadata, and the
 * composed transport facts of every Remote it mounts.
 *
 * @typedef {ArtifactReportBase & {
 *   kind?: undefined,
 *   shared: Record<string, string>,
 *   remotes: AppManifest['remotes'],
 *   security: ArtifactSecurity,
 * }} ShellArtifactReport
 */

/**
 * A Remote artifact: published on its own cadence, under its own versioned base,
 * and composed into a shell later. It carries no security metadata because the
 * shell owns the document, the import map and the policy that admits both.
 *
 * @typedef {ArtifactReportBase & {
 *   kind: 'remote',
 *   name: string,
 *   base: string,
 *   remote: RemoteTransport,
 * }} RemoteArtifactReport
 */

/** @typedef {ShellArtifactReport | RemoteArtifactReport} ArtifactReport */

/**
 * Read one artifact's report, and the bytes it was read from.
 *
 * The bytes are returned rather than re-serialized because a release names an
 * artifact by the hash of this exact file: re-encoding the parsed object would
 * produce a different identity for the same artifact the day the writer's key
 * order or spacing changed.
 *
 * @param {string} artifactRoot the directory holding the artifact
 * @returns {Promise<{ report: ArtifactReport, bytes: Buffer, path: string }>}
 */
export async function readReport(artifactRoot) {
  const path = join(artifactRoot, REPORT);
  const bytes = await readFile(path);
  return { report: parseReport(bytes, path), bytes, path };
}

/**
 * Write one artifact's report, refusing to publish a malformed one.
 *
 * The report is admitted before it reaches disk, so the build cannot emit a
 * document its own readers would reject. That check is the reason the five
 * poke-helpers this module replaced are gone: the shape is proved once, here,
 * rather than re-derived by every tool that opens the file.
 *
 * @template {ArtifactReport} T
 * @param {string} artifactRoot the directory to write the report into
 * @param {T} report
 * @returns {Promise<T>} the same report, deeply frozen
 */
export async function writeReport(artifactRoot, report) {
  const admitted = /** @type {T} */ (admitReport(report, join(artifactRoot, REPORT)));
  await writeFile(join(artifactRoot, REPORT), `${JSON.stringify(admitted, null, 2)}\n`);
  return freezeReport(admitted);
}

/**
 * Admit one artifact report from its serialized form.
 *
 * Pure: no filesystem, no build, no application. A suite states a document and
 * asserts what the contract does with it, which is the thing the untyped record
 * made impossible.
 *
 * @param {string | Buffer} source
 * @param {string} where the path or label to name in a refusal
 * @returns {ArtifactReport}
 */
export function parseReport(source, where) {
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(typeof source === 'string' ? source : source.toString('utf8'));
  } catch (cause) {
    throw new Error(`artifact-report: ${where}: cannot parse.`, { cause });
  }
  return admitReport(value, where);
}

/**
 * Narrow one report to a Remote's. A shell and a Remote are the same document
 * with different halves filled in, and `kind` is the discriminator.
 *
 * @param {ArtifactReport} report
 * @returns {report is RemoteArtifactReport}
 */
export function isRemoteReport(report) {
  return report.kind === 'remote';
}

/**
 * The report as a value nothing downstream can edit in place. A release, a
 * composition and a benchmark all hold the same object; one of them mutating it
 * would be a bug none of the three could see.
 *
 * @template {object} T
 * @param {T} value
 * @returns {T}
 */
export function freezeReport(value) {
  for (const entry of Object.values(value)) {
    if (typeof entry === 'object' && entry !== null && !Object.isFrozen(entry)) {
      freezeReport(/** @type {object} */ (entry));
    }
  }
  return Object.freeze(value);
}

/**
 * The whole contract, in one pass.
 *
 * @param {unknown} value
 * @param {string} where
 * @returns {ArtifactReport}
 */
function admitReport(value, where) {
  const report = record(value, where, 'report');
  if (report.version !== 1) {
    refuse(where, `unsupported report version ${JSON.stringify(report.version)}.`);
  }
  if (report.experimental !== undefined && typeof report.experimental !== 'boolean') {
    refuse(where, 'experimental must be a boolean when present.');
  }
  text(report.root, where, 'root');
  if (report.public !== PUBLIC) {
    refuse(where, `browser root must be ${JSON.stringify(PUBLIC)}.`);
  }
  if (typeof report.app !== 'string' || !NAME.test(report.app)) {
    refuse(where, 'app must be a package-safe name.');
  }
  admitRelease(report.release, where);
  text(report.target, where, 'target');
  admitCache(report.cache, where);
  text(report.entry, where, 'entry');
  admitChunks(report.chunks, where);
  admitChain(report.chain, String(report.entry), report.chunks, where);
  admitTemplates(report.templates, where);
  admitFiles(report.files, where);
  admitTotals(report.totals, where);

  if (report.kind === undefined) {
    admitShell(report, where);
  } else if (report.kind === 'remote') {
    admitRemote(report, where);
  } else {
    refuse(where, `unsupported report kind ${JSON.stringify(report.kind)}.`);
  }
  return /** @type {ArtifactReport} */ (/** @type {unknown} */ (report));
}

/** @param {Record<string, unknown>} report @param {string} where */
function admitShell(report, where) {
  const shared = record(report.shared, where, 'shared');
  for (const [specifier, url] of Object.entries(shared)) {
    if (typeof url !== 'string' || !url.startsWith('/')) {
      refuse(where, `shared ${specifier} must resolve to a same-origin URL.`);
    }
  }
  for (const remote of list(report.remotes, where, 'remotes')) {
    const entry = record(remote, where, 'remote entry');
    text(entry.name, where, 'remote name');
    text(entry.url, where, `remote ${String(entry.name)} url`);
    text(entry.integrity, where, `remote ${String(entry.name)} integrity`);
    text(entry.mount, where, `remote ${String(entry.name)} mount`);
    admitAssets(entry.assets, where, String(entry.name));
  }
  admitSecurity(report.security, where);
}

/** @param {Record<string, unknown>} report @param {string} where */
function admitRemote(report, where) {
  if (typeof report.name !== 'string' || !NAME.test(report.name)) {
    refuse(where, 'a Remote report must carry a package-safe name.');
  }
  const base = text(report.base, where, 'base');
  if (!base.startsWith('/') || !base.endsWith('/') || base.startsWith('//')) {
    refuse(where, `publication base must be an absolute directory URL: ${base}`);
  }
  const remote = record(report.remote, where, 'remote');
  if (remote.name !== report.name) {
    refuse(where, 'transport descriptor names another Remote.');
  }
  text(remote.url, where, 'remote url');
  text(remote.integrity, where, 'remote integrity');
  admitAssets(remote.assets, where, report.name);
  for (const specifier of list(remote.shared, where, 'remote shared')) {
    if (typeof specifier !== 'string' || specifier === '') {
      refuse(where, 'remote shared must contain bare specifiers.');
    }
  }
  for (const pattern of list(remote.locales, where, 'remote locales')) {
    if (typeof pattern !== 'string' || pattern === '') {
      refuse(where, 'remote locales must contain URL patterns.');
    }
  }
  if (remote.templates !== undefined) text(remote.templates, where, 'remote templates');
  // The shell turns this list into requests without reading the Remote's report a
  // second time, so a malformed entry here becomes a failed fetch inside a mounted
  // Remote rather than a message anyone connects to the build that produced it.
  for (const file of list(remote.templateFiles, where, 'remote templateFiles')) {
    if (typeof file !== 'string' || !file.startsWith(base)) {
      refuse(where, 'remote templateFiles must be URLs below the publication base.');
    }
  }
}

/** @param {unknown} value @param {string} where @param {string} name */
function admitAssets(value, where, name) {
  for (const asset of list(value, where, `remote ${name} assets`)) {
    const entry = record(asset, where, `remote ${name} asset`);
    text(entry.type, where, `remote ${name} asset type`);
    text(entry.url, where, `remote ${name} asset url`);
    text(entry.integrity, where, `remote ${name} asset integrity`);
  }
}

/**
 * The security half, and the one fact that spans it: a CSP that does not admit
 * the import map it was generated for is a page that will not load, and no
 * consumer downstream is in a position to notice.
 *
 * @param {unknown} value @param {string} where
 */
function admitSecurity(value, where) {
  const security = record(value, where, 'security');
  const csp = text(security.csp, where, 'security.csp');
  const importMap = record(security.importMap, where, 'security.importMap');
  text(importMap.source, where, 'security.importMap.source');
  const hash = text(importMap.sha256, where, 'security.importMap.sha256');
  for (const module of list(security.modules, where, 'security.modules')) {
    const entry = record(module, where, 'security module');
    text(entry.path, where, 'security module path');
    text(entry.integrity, where, 'security module integrity');
  }
  if (!INLINE_HASH.test(hash)) {
    refuse(where, `import map hash is not a base64 SHA-256: ${hash}`);
  }
  if (/["\\\r\n]/u.test(csp)) refuse(where, 'CSP carries a character a header cannot.');
  if (!csp.includes(`'${hash}'`)) refuse(where, 'CSP does not admit the reported import map.');
}

/** @param {unknown} value @param {string} where */
function admitRelease(value, where) {
  const release = record(value, where, 'release');
  if (release.commit !== null && (typeof release.commit !== 'string' || !COMMIT.test(release.commit))) {
    refuse(where, 'release.commit must be null or a commit hash.');
  }
  const epoch = release.sourceDateEpoch;
  if (epoch !== null && (!Number.isSafeInteger(epoch) || Number(epoch) < 0)) {
    refuse(where, 'release.sourceDateEpoch must be null or a non-negative integer.');
  }
}

/** @param {unknown} value @param {string} where */
function admitCache(value, where) {
  const cache = record(value, where, 'cache');
  text(cache.immutable, where, 'cache.immutable');
  text(cache.revalidate, where, 'cache.revalidate');
  if (cache.metadata !== null) refuse(where, 'cache.metadata must be null; metadata is not served.');
}

/** @param {unknown} value @param {string} where */
function admitChunks(value, where) {
  for (const chunk of list(value, where, 'chunks')) {
    const entry = record(chunk, where, 'chunk');
    const path = text(entry.path, where, 'chunk path');
    if (typeof entry.entry !== 'boolean' || typeof entry.dynamicEntry !== 'boolean') {
      refuse(where, `chunk ${path} must say whether it is an entry.`);
    }
    if (entry.facade !== null) text(entry.facade, where, `chunk ${path} facade`);
    for (const key of ['imports', 'dynamicImports', 'modules']) {
      for (const module of list(entry[key], where, `chunk ${path} ${key}`)) {
        if (typeof module !== 'string' || module === '') {
          refuse(where, `chunk ${path} ${key} must contain module paths.`);
        }
      }
    }
  }
}

/**
 * How deep the entry's static module graph is, in round trips.
 *
 * Breadth-first rather than longest-path, because the number this answers is when a
 * browser *discovers* a chunk, and a chunk reachable in one hop is discovered in one
 * hop however many longer routes also reach it. Breadth-first is also the only shape
 * that terminates on a circular chunk graph, which the engine is free to emit.
 *
 * Static imports only. A route chunk is a dynamic import, which route a visitor
 * lands on is not a build fact, and following those would report the depth of the
 * whole application rather than of its startup — the same line `entryHints` draws.
 *
 * The entry itself is depth 1: it is a transfer, and it is the one the document
 * names. So a graph the document flattens completely still reports the depth its
 * modules would have cost, which is what makes the number worth gating.
 *
 * @param {string} entry
 * @param {ReadonlyArray<Pick<ArtifactChunk, 'path' | 'imports'>>} chunks
 * @returns {ArtifactChain}
 */
export function entryChain(entry, chunks) {
  const byPath = new Map(chunks.map((chunk) => [chunk.path, chunk]));
  if (!byPath.has(entry)) return { depth: 0, path: [] };

  /** @type {Map<string, string | null>} The importer each chunk was first reached by. */
  const from = new Map([[entry, null]]);
  let frontier = [entry];
  let deepest = entry;

  while (frontier.length > 0) {
    /** @type {string[]} */
    const next = [];
    for (const path of frontier) {
      for (const imported of byPath.get(path)?.imports ?? []) {
        if (from.has(imported) || !byPath.has(imported)) continue;
        from.set(imported, path);
        next.push(imported);
      }
    }
    // The first chunk of the last non-empty level, so ties resolve by the sorted
    // order the report already stores its chunks and imports in.
    if (next.length > 0) deepest = /** @type {string} */ (next[0]);
    frontier = next;
  }

  /** @type {string[]} */
  const path = [];
  for (let at = /** @type {string | null} */ (deepest); at !== null; at = from.get(at) ?? null) {
    path.unshift(at);
  }
  return { depth: path.length, path };
}

/**
 * The chain is derived, so it is admitted by re-deriving it: a report whose stated
 * depth disagrees with its own `chunks[].imports` is describing a graph it does not
 * carry, and every consumer of the number would inherit the disagreement.
 *
 * @param {unknown} value @param {string} entry @param {unknown} chunks @param {string} where
 */
function admitChain(value, entry, chunks, where) {
  const chain = record(value, where, 'chain');
  count(chain.depth, where, 'chain.depth');
  for (const path of list(chain.path, where, 'chain.path')) {
    if (typeof path !== 'string' || path === '') refuse(where, 'chain.path must be chunk paths.');
  }
  const derived = entryChain(
    entry,
    /** @type {ArtifactChunk[]} */ (/** @type {unknown} */ (chunks)),
  );
  if (derived.depth === 0) {
    refuse(where, `entry ${entry} is not one of the chunks the report carries.`);
  }
  if (chain.depth !== derived.depth) {
    refuse(
      where,
      `chain.depth is ${String(chain.depth)}; the reported chunk graph is ${String(derived.depth)} deep.`,
    );
  }
  const stated = /** @type {string[]} */ (chain.path);
  if (stated.length !== derived.path.length || stated.some((path, at) => path !== derived.path[at])) {
    refuse(where, 'chain.path is not the chain the reported chunk graph produces.');
  }
}

/** @param {unknown} value @param {string} where */
function admitTemplates(value, where) {
  if (value === null) return;
  const templates = record(value, where, 'templates');
  if (typeof templates.delivery !== 'string' || !DELIVERIES.has(templates.delivery)) {
    refuse(where, `unsupported template delivery ${JSON.stringify(templates.delivery)}.`);
  }
  const bundled = templates.delivery === 'bundle';
  if (bundled) {
    text(templates.bundle, where, 'templates.bundle');
    text(templates.url, where, 'templates.url');
  } else if (templates.bundle !== null || templates.url !== null) {
    refuse(where, 'split template delivery names no bundle.');
  }
  count(templates.count, where, 'templates.count');
  count(templates.bytes, where, 'templates.bytes');
  const files = list(templates.files, where, 'templates.files');
  if (files.length !== templates.count) {
    refuse(where, 'templates.count differs from the emitted file list.');
  }
  for (const file of files) {
    if (typeof file !== 'string' || file === '') refuse(where, 'templates.files must be paths.');
  }
}

/** @param {unknown} value @param {string} where */
function admitFiles(value, where) {
  const seen = new Set();
  for (const file of list(value, where, 'files')) {
    const entry = record(file, where, 'inventory record');
    const path = text(entry.path, where, 'inventory path');
    if (seen.has(path)) refuse(where, `duplicate inventory path ${path}.`);
    seen.add(path);
    if (typeof entry.cache !== 'string' || !CACHE_CLASSES.has(entry.cache)) {
      refuse(where, `unsupported cache class for ${path}.`);
    }
    count(entry.bytes, where, `${path} bytes`);
    count(entry.gzip, where, `${path} gzip`);
    count(entry.brotli, where, `${path} brotli`);
    if (typeof entry.sha256 !== 'string' || !DIGEST.test(entry.sha256)) {
      refuse(where, `${path} carries no SHA-256 digest.`);
    }
  }
  if (seen.has(REPORT)) refuse(where, `the inventory may not list ${REPORT} itself.`);
}

/** @param {unknown} value @param {string} where */
function admitTotals(value, where) {
  const totals = record(value, where, 'totals');
  for (const key of ['files', 'bytes', 'gzip', 'brotli']) {
    count(totals[key], where, `totals.${key}`);
  }
}

/** @param {unknown} value @param {string} where @param {string} name */
function record(value, where, name) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    refuse(where, `${name} must be an object.`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value @param {string} where @param {string} name */
function list(value, where, name) {
  if (!Array.isArray(value)) refuse(where, `${name} must be an array.`);
  return /** @type {unknown[]} */ (value);
}

/** @param {unknown} value @param {string} where @param {string} name */
function text(value, where, name) {
  if (typeof value !== 'string' || value === '') refuse(where, `${name} must be a string.`);
  return value;
}

/** @param {unknown} value @param {string} where @param {string} name */
function count(value, where, name) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    refuse(where, `${name} must be a non-negative integer.`);
  }
  return Number(value);
}

/**
 * @param {string} where
 * @param {string} detail
 * @returns {never}
 */
function refuse(where, detail) {
  throw new Error(`artifact-report: ${where}: ${detail}`);
}
