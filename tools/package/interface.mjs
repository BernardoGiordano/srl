/**
 * What the library publishes, derived from the library's own manifest.
 *
 * The package is `source/`: source/package.json declares the mounts a browser
 * sees, the bare specifier prefixes source is written against, and the vendored
 * runtime dependencies. This module is the only thing that reads that manifest,
 * and everything else — the dev server, the test-runner origin, the benchmark
 * origin, the verifier, the build, the deployment — asks here rather than
 * restating the table.
 *
 * The split from tools/layout.mjs is the point of the file: the package's facts
 * live here, the repository's live there, and only the second are true of this
 * repository in particular. ADR-0033. That is what gives a consumer outside this
 * repository something to import, and makes extracting the library a file move.
 *
 * Zero dependencies, and the manifest is read synchronously at load, so importing
 * this module gives constants rather than promises and works before `npm install`
 * like the rest of tools/.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)));

/**
 * The package root: the directory whose package.json carries an `srl` field.
 *
 * Two candidates, tried in order, because tools/ travels with the library. In a
 * standalone srl checkout the package is the repository root; in a repository
 * that holds the library plus the applications built on it, it is source/. A
 * search rather than a constant so that neither shape needs an edit here.
 */
function findPackage() {
  for (const candidate of [resolve(HERE, '..', '..'), resolve(HERE, '..', '..', 'source')]) {
    try {
      const manifest = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8'));
      if (manifest.srl !== undefined) return { dir: candidate, manifest };
    } catch {
      continue;
    }
  }
  throw new Error(
    'No package.json with an `srl` field was found next to tools/. The library manifest is ' +
      'what declares the mounts, the specifier prefixes and the vendored dependencies; without ' +
      'it nothing here can tell where the library is served from.',
  );
}

const found = findPackage();

/** The library's directory: the root of a standalone srl checkout. */
export const PACKAGE = found.dir;

/** source/package.json, parsed. The declaration every table below is derived from. */
export const MANIFEST = found.manifest;

/**
 * URL prefix -> directory. What a browser sees of the package, absolute on disk.
 *
 * Order is the manifest's, and it matters: resolution takes the first prefix that
 * matches, so a mount nested inside another must be declared before it.
 */
export const MOUNTS = /** @type {Array<[string, string]>} */ (
  Object.entries(MANIFEST.srl.mounts).map(([prefix, dir]) => [
    prefix,
    join(PACKAGE, /** @type {string} */ (dir)),
  ])
);

/**
 * A package-relative directory as the URL it is served at: `lib/core` ->
 * `/lib/core/`. Throws rather than guessing, because a prefix pointing at a
 * directory no mount covers is an interface that 404s in a browser and nowhere
 * earlier.
 *
 * @param {string} dir
 * @returns {string}
 */
function mountedUrl(dir) {
  for (const [prefix, target] of Object.entries(MANIFEST.srl.mounts)) {
    const mount = /** @type {string} */ (target);
    if (dir === mount) return prefix;
    if (dir.startsWith(`${mount}/`)) return `${prefix}${dir.slice(mount.length + 1)}/`;
  }
  throw new Error(
    `The library manifest maps a specifier to "${dir}", which no mount serves. Every directory ` +
      `named in \`srl.imports\` must sit under one of \`srl.mounts\`.`,
  );
}

/** Bare specifier prefix -> the URL it resolves to: `@core/` -> `/lib/core/`. */
export const SPECIFIERS = /** @type {Record<string, string>} */ (
  Object.fromEntries(
    Object.entries(MANIFEST.srl.imports).map(([prefix, dir]) => [
      prefix,
      mountedUrl(/** @type {string} */ (dir)),
    ]),
  )
);

/** Bare specifier prefix -> the directory on disk it must resolve into. */
export const SPECIFIER_DIRS = /** @type {Record<string, string>} */ (
  Object.fromEntries(
    Object.entries(MANIFEST.srl.imports).map(([prefix, dir]) => [
      prefix,
      join(PACKAGE, /** @type {string} */ (dir)),
    ]),
  )
);

/** The framework: core, auth, host and the vendored runtime dependencies. */
export const LIB = join(PACKAGE, MANIFEST.srl.mounts['/lib/']);

/** The reusable component collection built on it. */
export const COMPONENTS = join(PACKAGE, MANIFEST.srl.mounts['/components/']);

/** Third-party bytes, committed and integrity-pinned. */
export const VENDOR = join(LIB, 'vendor');

/**
 * What a file is served as, by extension.
 *
 * Part of the package's interface rather than of any one server: two servers on
 * one origin (the dev server and the benchmark origin) must agree that `.js` is
 * JavaScript, or one of them measures a page the other cannot run. nginx reads
 * its own copy from mime.types, which is the same table by another name.
 */
export const MIME = new Map(
  Object.entries({
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.map': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
  }),
);

/**
 * The Content-Type for a file path, defaulting to bytes rather than to a guess.
 *
 * @param {string} path
 * @returns {string}
 */
export function contentType(path) {
  return MIME.get(extname(path).toLowerCase()) ?? 'application/octet-stream';
}

/**
 * The file a mounted URL resolves to, or null for a URL that is the
 * application's rather than the package's.
 *
 * @param {string} url
 * @returns {string | null}
 */
export function mountedFile(url) {
  const path = url.split('?')[0] ?? url;
  for (const [prefix, dir] of MOUNTS) {
    if (path.startsWith(prefix)) return join(dir, path.slice(prefix.length));
  }
  return null;
}

/**
 * Resolve a root-absolute browser URL to a file, the way the dev server and the
 * deployment do: the package's mounts first, then the application.
 *
 * @param {string} appDir
 * @param {string} url
 * @returns {string}
 */
export function urlToFile(appDir, url) {
  const mounted = mountedFile(url);
  if (mounted !== null) return mounted;
  const path = url.split('?')[0] ?? url;
  return join(appDir, path.replace(/^\//u, ''));
}

/**
 * The reverse: the URL a file is served at, for the given application. Returns
 * null for a file no browser can reach.
 *
 * @param {string} appDir
 * @param {string} file
 * @returns {string | null}
 */
export function fileToUrl(appDir, file) {
  for (const [prefix, dir] of MOUNTS) {
    if (file.startsWith(dir + sep)) {
      return prefix + file.slice(dir.length + 1).split(sep).join('/');
    }
  }
  if (file.startsWith(appDir + sep)) {
    return `/${file.slice(appDir.length + 1).split(sep).join('/')}`;
  }
  return null;
}

/**
 * Pull the inline import map out of an HTML document or a config file.
 *
 * @param {string} html
 * @param {string} where
 * @returns {{ imports: Record<string, string>, integrity: Record<string, string>, body: string }}
 */
export function extractImportMap(html, where) {
  const match = /<script\s+type=["']importmap["']\s*>([\s\S]*?)<\/script>/u.exec(html);
  if (match?.[1] === undefined) throw new Error(`No inline import map found in ${where}.`);
  const parsed = JSON.parse(match[1]);
  return { imports: parsed.imports ?? {}, integrity: parsed.integrity ?? {}, body: match[1] };
}

/**
 * Every vendored URL an HTML document actually references: import map targets,
 * plus classic `<script src>` tags, which carry their hash as an attribute
 * instead.
 *
 * @param {string} html
 * @param {string} where
 * @returns {Map<string, string | undefined>} url -> declared integrity, if any
 */
export function vendorReferences(html, where) {
  const vendorUrl = `${mountedUrl(`${MANIFEST.srl.mounts['/lib/']}/vendor`)}`;
  const { imports, integrity } = extractImportMap(html, where);
  /** @type {Map<string, string | undefined>} */
  const found = new Map();

  for (const url of Object.values(imports)) {
    if (url.startsWith(vendorUrl)) found.set(url, integrity[url]);
  }
  for (const tag of html.matchAll(/<script\b[^>]*>/gu)) {
    const src = /\ssrc=["']([^"']+)["']/u.exec(tag[0])?.[1];
    if (src === undefined || !src.startsWith(vendorUrl)) continue;
    found.set(src, /\sintegrity=["']([^"']+)["']/u.exec(tag[0])?.[1]);
  }

  return found;
}

/**
 * The registry half of the interface: one emitted bundle per entry.
 *
 * `imports` names the specifier prefixes a bundle is a barrel over, and `extends`
 * names the bundle whose prefixes stay external to it. Both are prefixes rather
 * than directories so that this table and `srl.imports` cannot describe different
 * sets of files.
 *
 * @typedef {{
 *   name: string,
 *   subpath: string,
 *   imports: string[],
 *   extends?: string,
 *   exclude?: string[],
 *   file: string,
 *   minified: string,
 *   roots: string[],
 *   excluded: string[],
 *   external: string[],
 * }} PackageBundle
 */

/** @type {PackageBundle[]} */
export const BUNDLES = Object.entries(
  /** @type {Record<string, { subpath: string, imports: string[], extends?: string, exclude?: string[] }>} */ (
    MANIFEST.srl.bundles ?? {}
  ),
).map(([name, entry]) => {
  const inherited = entry.extends;
  const parent =
    inherited === undefined
      ? undefined
      : /** @type {{ imports: string[] } | undefined} */ (
          /** @type {Record<string, { imports: string[] }>} */ (MANIFEST.srl.bundles)[inherited]
        );
  if (inherited !== undefined && parent === undefined) {
    throw new Error(`Bundle "${name}" extends "${inherited}", which the manifest does not declare.`);
  }

  return {
    name,
    subpath: entry.subpath,
    imports: entry.imports,
    extends: inherited,
    exclude: entry.exclude,
    file: `dist/${name}.js`,
    minified: `dist/${name}.min.js`,
    roots: entry.imports.map((prefix) => requirePrefixDir(name, prefix)),
    excluded: (entry.exclude ?? []).map((dir) => join(PACKAGE, dir)),
    external: parent?.imports ?? [],
  };
});

/**
 * @param {string} bundle
 * @param {string} prefix
 * @returns {string}
 */
function requirePrefixDir(bundle, prefix) {
  const dir = SPECIFIER_DIRS[prefix];
  if (dir === undefined) {
    throw new Error(
      `Bundle "${bundle}" claims specifier prefix "${prefix}", which \`srl.imports\` does not ` +
        `declare. A bundle is a barrel over prefixes, so it cannot claim one that resolves nowhere.`,
    );
  }
  return dir;
}

/**
 * The `exports` map the manifest implies.
 *
 * Derived rather than authoritative: package.json states `exports` literally,
 * because npm reads that file and not this one, and tools/checks/verify-deps.mjs
 * compares the two. A bundle added to `srl.bundles` and forgotten in `exports`
 * fails a check instead of shipping a package whose registry consumers cannot
 * reach half of it.
 *
 * The raw `lib/` and `components/` trees are deliberately *not* here. They ship —
 * they are what the import-map consumer loads — but every module in them names
 * `@core/` and friends, so an `exports` entry pointing a bundler at one would
 * advertise a subpath that throws on its first import. The bundles are that
 * consumer's entry, and `./dist/*` reaches the minified pair by name.
 *
 * @returns {Record<string, string>}
 */
export function packageExports() {
  return {
    ...Object.fromEntries(BUNDLES.map((bundle) => [bundle.subpath, `./${bundle.file}`])),
    './dist/*': './dist/*',
  };
}

/**
 * The subresource integrity hash for a file, in the form the browser enforces.
 *
 * @param {string} file
 * @returns {Promise<string>}
 */
export async function subresourceIntegrity(file) {
  return `sha384-${createHash('sha384').update(await readFile(file)).digest('base64')}`;
}

/** Where the generated fragment is written, and the URL it is served at. */
export const IMPORT_MAP_FILE = join(LIB, 'importmap.json');
export const IMPORT_MAP_URL = `${mountedUrl(MANIFEST.srl.mounts['/lib/'])}importmap.json`;

/**
 * The import-map fragment every application on this library carries: the
 * vendored dependencies with the hashes of the bytes actually in lib/vendor,
 * then the library's own prefixes.
 *
 * An application's own entries — its remotes, its `/src/` — are not here and
 * never can be: the fragment is what the library publishes, and the map is the
 * application's, which is why this is a fragment rather than the whole file.
 *
 * @returns {Promise<{ imports: Record<string, string>, integrity: Record<string, string> }>}
 */
export async function importMapFragment() {
  const vendor = /** @type {Record<string, string>} */ (MANIFEST.srl.vendor);
  /** @type {Record<string, string>} */
  const integrity = {};

  for (const url of new Set(Object.values(vendor))) {
    const file = mountedFile(url);
    if (file === null) {
      throw new Error(`The manifest vendors ${url}, which no mount serves.`);
    }
    integrity[url] = await subresourceIntegrity(file);
  }

  return { imports: { ...vendor, ...SPECIFIERS }, integrity };
}

/**
 * The fragment as the bytes on disk: committed, so a consumer with no Node at
 * all can read it, and fetchable at `/lib/importmap.json` by one that would
 * rather assemble its map at runtime.
 *
 * @returns {Promise<string>}
 */
export async function importMapText() {
  return `${JSON.stringify(await importMapFragment(), null, 2)}\n`;
}

/* ── As a command ──────────────────────────────────────────────────────────
 *
 * `--write` regenerates the committed fragment; with no argument it prints it,
 * which is what a consumer pasting it into an index.html wants. Guarded, so
 * importing this module stays free of output and exit codes.
 */

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = await importMapText();
  if (process.argv.includes('--write')) {
    await writeFile(IMPORT_MAP_FILE, text);
    console.log('wrote %s', IMPORT_MAP_FILE);
  } else {
    process.stdout.write(text);
  }
}
