/**
 * An application's inline import map against the library it actually installed.
 *
 *   node cli/checks/importmap-check.mjs [--app <name>]     one application, or all
 *
 * Four failures, and the first three are a blank page rather than a build error.
 *
 *  1. The map omits or hand-edits an entry the library publishes. The page loads,
 *     fetches its entry module, and dies on "Failed to resolve module specifier
 *     @core/…" — a resolution error, in a browser, on whichever route needed the
 *     layer that was missing.
 *  2. A library prefix resolves somewhere that is not the installed package. The
 *     application then runs a copy of the framework: a second custom element
 *     registry, a second injector, a second template cache. Everything works until
 *     two components from the two copies meet.
 *  3. An integrity hash that does not match the bytes it covers. The browser
 *     refuses the module outright, and refuses it silently as far as the page is
 *     concerned.
 *  4. A vendored URL the map names and no file answers. A 404 on one route.
 *
 * The fourth thing it does is not a failure: it prints the `script-src` hash the
 * map needs. An import map is an inline script, so a CSP of `script-src 'self'`
 * blocks it, and the symptom is failure 1 with no visible violation in the console.
 * Nobody should have to derive that value by hand.
 *
 * What this deliberately does not check is the application's own entries — its
 * remotes, its `/src/`, its own vendored dependencies' *specifiers*. Those are the
 * application's to declare. Every `integrity` entry is checked, whoever put it
 * there, because a hash nobody verifies is a hash that rots.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { REPO, apps, exists, readText, selectedApp } from '../layout.mjs';
import {
  IMPORT_MAP_FILE,
  PACKAGE,
  SPECIFIER_DIRS,
  extractImportMap,
  importMapFragment,
  urlToFile,
} from '../package/interface.mjs';

/** @type {string[]} */
const problems = [];

/** @param {string} message */
function fail(message) {
  problems.push(message);
}

/** @param {string} path */
function show(path) {
  const inside = relative(REPO, path);
  return inside.startsWith('..') ? path : inside.split(sep).join('/');
}

/**
 * Whether a URL names third-party bytes: a `vendor` path segment.
 *
 * The convention rather than a configured list, because both halves of the
 * arrangement already follow it — the library commits its runtime dependencies to
 * `lib/vendor/`, and an application that vendors its own puts them in
 * `<app>/vendor/`. A segment, not a substring, so `/src/vendored-icons.js` is the
 * application's own code and stays so.
 *
 * @param {string} url
 * @returns {boolean}
 */
function isVendored(url) {
  return url.split('/').includes('vendor');
}

/**
 * The applications to check: the one named, or every one in the repository.
 *
 * `--app` is optional here and required nowhere else, because this check is
 * cheap and reads nothing it could damage. A repository with two applications
 * wants both checked by default; a build wants to be told which one.
 *
 * @returns {Promise<Array<{ name: string, dir: string }>>}
 */
async function selection() {
  if (process.argv.includes('--app')) return [await selectedApp()];
  const all = await apps();
  if (all.length === 0) {
    throw new Error(
      `No application with an index.html was found in ${show(REPO)}. An application is any ` +
        `directory in the repository root with an index.html; if this repository keeps its own ` +
        `elsewhere, point SRL_ROOT at the root that holds them.`,
    );
  }
  return all;
}

/**
 * Check one application.
 *
 * @param {{ name: string, dir: string }} app
 * @param {{ imports: Record<string, string>, integrity: Record<string, string> }} fragment
 * @returns {Promise<void>}
 */
async function checkApplication(app, fragment) {
  console.log('\n%s', app.name);

  const html = await readText(join(app.dir, 'index.html'));
  const { imports, integrity, body } = extractImportMap(html, `${app.name}/index.html`);

  /* ── 1. The map carries what the library publishes, verbatim ─────────── */

  let verbatim = true;
  for (const [specifier, url] of Object.entries(fragment.imports)) {
    if (imports[specifier] === undefined) {
      verbatim = false;
      fail(
        `${app.name}: the import map does not declare "${specifier}". The library publishes it ` +
          `in ${show(IMPORT_MAP_FILE)}; an application that omits it 404s on the route that ` +
          `needs it.`,
      );
    } else if (imports[specifier] !== url) {
      verbatim = false;
      fail(
        `${app.name}: the import map resolves "${specifier}" to ${imports[specifier]}, and the ` +
          `library publishes ${url}. Paste ${show(IMPORT_MAP_FILE)} rather than editing a copy ` +
          `of it.`,
      );
    }
  }
  for (const [url, hash] of Object.entries(fragment.integrity)) {
    if (integrity[url] !== hash) {
      verbatim = false;
      fail(
        `${app.name}: ${url} is pinned to ${integrity[url] ?? 'nothing'}, and the library's own ` +
          `bytes hash to ${hash}. Paste ${show(IMPORT_MAP_FILE)}.`,
      );
    }
  }
  if (verbatim) {
    console.log(
      '  ok   carries the library fragment verbatim: %s import(s), %s hash(es)',
      String(Object.keys(fragment.imports).length),
      String(Object.keys(fragment.integrity).length),
    );
  }

  /* ── 2. The library's prefixes resolve into the installed package ────── */

  let resolved = true;
  for (const [prefix, dir] of Object.entries(SPECIFIER_DIRS)) {
    const target = imports[prefix];
    if (target === undefined) continue; // An application need not use every layer.
    const file = urlToFile(app.dir, target);
    if (file !== `${dir}${sep}` && file !== dir) {
      resolved = false;
      fail(
        `${app.name}: the import map resolves "${prefix}" to ${target}, which is ${show(file)} ` +
          `and not ${show(dir)}. The library's prefixes have to point at the package this check ` +
          `is reading, or the application is silently running a second copy of the framework.`,
      );
    }
  }
  if (resolved) console.log('  ok   library prefixes resolve into %s', show(PACKAGE));

  /* ── 3. Every hash matches the bytes it covers ───────────────────────── */

  let checked = 0;
  for (const [url, declared] of Object.entries(integrity)) {
    const file = urlToFile(app.dir, url);
    if (!(await exists(file))) {
      fail(
        `${app.name}: the integrity map pins ${url}, which resolves to ${show(file)} and is not ` +
          `there. The browser fetches the URL and gets a 404 on the route that imports it.`,
      );
      continue;
    }
    const actual = `sha384-${createHash('sha384').update(await readFile(file)).digest('base64')}`;
    if (actual !== declared) {
      fail(
        `${app.name}: ${url} is pinned to ${declared}, and ${show(file)} hashes to ${actual}. ` +
          `The browser refuses a module whose hash does not match, which is a page that stops ` +
          `loading rather than a page that loads wrong.`,
      );
      continue;
    }
    checked += 1;
  }
  if (checked > 0) console.log('  ok   %s hashed file(s) match their bytes', String(checked));

  /* ── 4. Vendored URLs the map names, and classic script tags ─────────── */

  const unhashed = [];
  for (const url of new Set(Object.values(imports))) {
    if (!url.startsWith('/')) continue; // A bare specifier is somebody else's resolver.
    if (!(await exists(urlToFile(app.dir, url)))) {
      fail(`${app.name}: the import map points at ${url}, which does not exist.`);
    } else if (integrity[url] === undefined && !url.endsWith('/')) {
      unhashed.push(url);
    }
  }
  if (unhashed.length > 0) {
    console.log(
      '  note %s mapped file(s) carry no integrity hash: %s',
      String(unhashed.length),
      unhashed.join(', '),
    );
  }

  // A script tag outside the map — the Tailwind development build is one — carries its
  // hash as an attribute or not at all. Only vendored ones are required to: pinning is
  // for bytes somebody else wrote, and an application's own `/src/` module changes with
  // every deploy, so a hash on it would be a line to update rather than a control.
  // Nothing requires such a tag to be present; a production page has none.
  for (const tag of html.matchAll(/<script\b[^>]*\ssrc=["'](\/[^"']+)["'][^>]*>/gu)) {
    const src = tag[1];
    if (src === undefined || !isVendored(src)) continue;
    if (/\sintegrity=/u.test(tag[0])) {
      console.log('  ok   %s pinned by attribute', src);
    } else {
      fail(
        `${app.name}: <script src="${src}"> has no integrity attribute. A classic script is not ` +
          `covered by the import map's integrity block, so these are third-party bytes nothing ` +
          `is checking.`,
      );
    }
  }

  /* ── 5. The CSP hash the deployment has to allow ─────────────────────── */

  console.log(
    "  ok   script-src must allow 'sha256-%s'",
    createHash('sha256').update(body, 'utf8').digest('base64'),
  );
}

/**
 * Check every selected application against the installed library.
 *
 * @returns {Promise<number>} the number of problems found
 */
export async function checkImportMaps() {
  const fragment = await importMapFragment();

  if (!(await exists(IMPORT_MAP_FILE))) {
    fail(
      `${show(IMPORT_MAP_FILE)} does not exist. It is the fragment the library publishes and ` +
        `the thing every application pastes; without it there is nothing to compare against.`,
    );
    return report();
  }

  for (const app of await selection()) await checkApplication(app, fragment);
  return report();
}

/** @returns {number} */
function report() {
  if (problems.length === 0) {
    console.log('\nEvery import map matches the installed library.');
    return 0;
  }
  console.error('\n%s import map problem(s):\n', String(problems.length));
  for (const problem of problems) console.error('  - %s\n', problem);
  return problems.length;
}

/* ── As a command ──────────────────────────────────────────────────────────
 *
 * Guarded, so importing this module stays free of output and exit codes.
 */

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exit((await checkImportMaps()) === 0 ? 0 : 1);
}
