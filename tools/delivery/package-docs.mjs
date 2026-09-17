/**
 * The documentation half of each package, which is the docs tree and an llms.txt index.
 *
 *   node tools/delivery/package-docs.mjs            copy docs/ into both published packages
 *   node tools/delivery/package-docs.mjs --check    fail if a copy is absent or stale
 *
 * Source comments in both packages cite decision records by number, and the guides
 * explain what the packages export. Someone who installed the packages has no checkout.
 * So each package carries `docs/` as it stood when the package was built, with an
 * `llms.txt` at its root that lists every page. A citation in
 * `node_modules/@srljs/cli` then resolves inside `node_modules/@srljs/cli`, at the
 * installed version. ADR-0121.
 *
 * Both packages carry the whole tree. The CLI pins the core version, but a path from one
 * package into the other depends on how the package manager laid out node_modules.
 *
 * The copy is refused when a page links to a file the package does not contain,
 * because that link works in the checkout and breaks once installed. The index is
 * refused when a guide or reference page is missing from docs/README.md, because
 * llms.txt is built from that page's tables.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix, relative, sep } from 'node:path';

import { errors } from '../../cli/diagnostics/index.mjs';
import { REPO, exists, readText, walk } from '../../cli/layout.mjs';
import { PACKAGE } from '../../cli/package/interface.mjs';
import { readRecords } from '../checks/adr-check.mjs';

/** The tree every package ships a copy of. */
export const DOCS = join(REPO, 'docs');

/** Where the copy lands inside a package, and where its index sits. */
const SHIPPED = 'docs';
const INDEX = 'llms.txt';

/**
 * The tables in docs/README.md, by heading, and the llms.txt section each one becomes.
 * The order here is the order in llms.txt. The decision records follow the reference.
 * `Optional` is the llms.txt name for pages a reader with little room may skip, and
 * the "Start here" pages describe the repository rather than the installed package.
 */
const SECTIONS = new Map([
  ['Guide', 'Guides'],
  ['Reference', 'Reference'],
  ['Start here', 'Optional'],
]);

/** A table row in docs/README.md that links a page. */
const INDEX_ROW = /^\| \[([^\]]+)\]\(([^)\s]+)\) \| (.+?) \|$/u;

/** A markdown link, inline form. The only form docs/ uses. */
const LINK = /\]\(([^)\s]+)\)/gu;

/**
 * The relative link targets in one markdown page, without their fragments.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function relativeLinks(text) {
  return [...text.matchAll(LINK)]
    .map((match) => (match[1] ?? '').split('#')[0] ?? '')
    .filter((target) => target !== '' && !/^[a-z][a-z0-9+.-]*:/iu.test(target));
}

/**
 * Where a link written in `page` points, as a path inside the package, or null when it
 * leaves the package.
 *
 * @param {string} page A `/`-separated path inside the package.
 * @param {string} target
 * @returns {string | null}
 */
export function linkTarget(page, target) {
  const resolved = posix.normalize(posix.join(posix.dirname(page), target));
  return resolved.startsWith('../') ? null : resolved.replace(/\/$/u, '');
}

/**
 * The index rows of docs/README.md, by the llms.txt section they go in.
 *
 * @param {string} text
 * @returns {Map<string, Array<{ title: string, path: string, summary: string }>>}
 */
function indexRows(text) {
  /** @type {Map<string, Array<{ title: string, path: string, summary: string }>>} */
  const sections = new Map([...SECTIONS.values()].map((name) => [name, []]));
  let heading = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      heading = line.slice(3).trim();
      continue;
    }
    const row = INDEX_ROW.exec(line);
    if (row === null) continue;
    const section = SECTIONS.get(heading);
    if (section === undefined) {
      throw new Error(
        `docs/README.md lists pages under "${heading}", which llms.txt has no section for. ` +
          `Add the heading to SECTIONS in tools/delivery/package-docs.mjs.`,
      );
    }
    sections.get(section)?.push({
      title: row[1] ?? '',
      path: posix.join(SHIPPED, row[2] ?? ''),
      summary: row[3] ?? '',
    });
  }
  return sections;
}

/**
 * The llms.txt for one package.
 *
 * @param {{ name: string, version: string, description: string }} manifest
 * @param {Map<string, Array<{ title: string, path: string, summary: string }>>} rows
 * @param {Array<{ id: string, title: string, status: string, file: string }>} records
 * @returns {string}
 */
function llmsIndex(manifest, rows, records) {
  /** @param {string} name @param {string[]} items */
  const section = (name, items) => ['', `## ${name}`, '', ...items];
  /** @param {{ title: string, path: string, summary: string }} row */
  const item = (row) => `- [${row.title}](${row.path}): ${row.summary}`;

  const lines = [
    `# ${manifest.name}`,
    '',
    `> ${manifest.description}`,
    '',
    `This is the srl documentation as of ${manifest.name} ${manifest.version}. The package ` +
      `build copied it from the repository. Every link below is relative to this file.`,
    '',
    'A source comment that cites `ADR-NNNN` refers to the decision record ' +
      '`docs/adr/NNNN-*.md`. The number never changes, even when the title does.',
    '',
    '- [Package README](README.md): installation and first steps for this package.',
    ...section('Guides', (rows.get('Guides') ?? []).map(item)),
    ...section('Reference', (rows.get('Reference') ?? []).map(item)),
    ...section('Decision records', [
      `- [Index](${SHIPPED}/adr/README.md): every record with its status and the files it affects.`,
      ...records.map((record) => {
        const state = record.status === 'accepted' ? '' : `: ${record.status}`;
        return `- [${record.id}: ${record.title}](${SHIPPED}/adr/${record.file})${state}`;
      }),
    ]),
    ...section('Optional', (rows.get('Optional') ?? []).map(item)),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Every documentation file one package ships, keyed by its `/`-separated path inside the
 * package.
 *
 * @param {string} root The package directory. Its package.json names the package.
 * @param {{ docs?: string }} [options] The tree to copy. The suite points it at a fixture.
 * @returns {Promise<Map<string, string>>}
 */
export async function packageDocs(root, { docs = DOCS } = {}) {
  const manifest = /** @type {{ name: string, version: string, description: string }} */ (
    JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  );

  /** @type {Map<string, string>} */
  const files = new Map();
  for (const file of (await walk(docs, /\.md$/u)).sort()) {
    const inside = posix.join(SHIPPED, relative(docs, file).split(sep).join('/'));
    files.set(inside, await readText(file));
  }

  /** @type {string[]} */
  const problems = [];

  // A link is kept when it lands on a shipped page, on a directory of shipped pages, or
  // on a file the package already has, such as its README.
  const directories = new Set([...files.keys()].flatMap((path) => ancestors(path)));
  for (const [page, text] of files) {
    for (const target of relativeLinks(text)) {
      const resolved = linkTarget(page, target);
      if (resolved !== null && (files.has(resolved) || directories.has(resolved))) continue;
      if (resolved !== null && (await exists(join(root, resolved)))) continue;
      problems.push(`${page} links to ${target}, which ${manifest.name} does not contain.`);
    }
  }

  const { records, diagnostics } = await readRecords(join(docs, 'adr'));
  if (errors(diagnostics).length > 0) {
    problems.push(`${relative(REPO, join(docs, 'adr'))} has malformed records. Run \`npm run docs:adr\`.`);
  }

  const rows = indexRows(await readText(join(docs, 'README.md')));
  const index = llmsIndex(
    manifest,
    rows,
    [...records.values()].sort((left, right) => left.number - right.number),
  );

  // Every page a reader would look for has to be reachable from the index.
  const listed = new Set(relativeLinks(index));
  for (const page of files.keys()) {
    if (page === `${SHIPPED}/README.md` || page.startsWith(`${SHIPPED}/adr/`)) continue;
    if (!listed.has(page)) {
      problems.push(`${page} is not in docs/README.md, so llms.txt would not list it.`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`The documentation cannot ship as it is:\n  ${problems.join('\n  ')}`);
  }

  files.set(INDEX, index);
  return files;
}

/**
 * The directories above a path, nearest first, without the path itself.
 *
 * @param {string} path
 * @returns {string[]}
 */
function ancestors(path) {
  /** @type {string[]} */
  const found = [];
  for (let dir = posix.dirname(path); dir !== '.'; dir = posix.dirname(dir)) found.push(dir);
  return found;
}

/**
 * Replace a package's documentation with `files`.
 *
 * The old tree goes first, so a page deleted from docs/ leaves no copy behind.
 *
 * @param {string} root
 * @param {Map<string, string>} files
 * @returns {Promise<void>}
 */
export async function writePackageDocs(root, files) {
  await rm(join(root, SHIPPED), { recursive: true, force: true });
  await rm(join(root, INDEX), { force: true });
  for (const [path, text] of files) {
    const target = join(root, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text, 'utf8');
  }
}

/**
 * The paths inside a package whose documentation differs from `files`.
 *
 * @param {string} root
 * @param {Map<string, string>} files
 * @returns {Promise<string[]>}
 */
export async function staleDocs(root, files) {
  /** @type {string[]} */
  const stale = [];
  for (const [path, text] of files) {
    const target = join(root, ...path.split('/'));
    const current = (await exists(target)) ? await readText(target) : null;
    if (current !== text) stale.push(path);
  }
  for (const file of await walk(join(root, SHIPPED), /$/u)) {
    const path = relative(root, file).split(sep).join('/');
    if (!files.has(path)) stale.push(path);
  }
  return stale.sort();
}

/**
 * The two packages a stranger installs, @srljs/core and @srljs/cli. Spelled out for the
 * reason tools/checks/verify-deps.mjs gives for its package pages.
 */
export const PUBLISHED = [PACKAGE, join(REPO, 'cli')];

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes('--check');

  for (const root of PUBLISHED) {
    const name = relative(REPO, root);
    const files = await packageDocs(root);

    if (check) {
      const stale = await staleDocs(root, files);
      if (stale.length === 0) {
        console.log(`  ok   ${`${name}/${SHIPPED}/`.padEnd(24)} ${String(files.size).padStart(8)} file(s) current`);
        continue;
      }
      console.error(
        `Stale in ${name}: ${stale.map((path) => `${name}/${path}`).join(', ')}. Run \`npm run package\`.`,
      );
      process.exitCode = 1;
      continue;
    }

    await writePackageDocs(root, files);
    console.log(`  ok   ${`${name}/${SHIPPED}/`.padEnd(24)} ${String(files.size - 1).padStart(8)} page(s), ${INDEX}`);
  }
}
