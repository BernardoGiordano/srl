/**
 * Fetch and verify the library's vendored runtime dependencies.
 *
 * No application needs this script. `source/lib/vendor` is committed, so a clone
 * runs with no npm install, no network and no tooling. This exists for the two
 * maintenance operations that do need the network:
 *
 *   node tools/delivery/vendor.mjs                verify committed bytes against the hashes
 *   node tools/delivery/vendor.mjs --fetch        re-download and verify before writing
 *   node tools/delivery/vendor.mjs --fetch --accept-new
 *                                        accept new bytes and print the new hash
 *   node tools/delivery/vendor.mjs --write-licenses
 *                                        regenerate LICENSES.md from node_modules
 *
 * The verify mode is offline and is what `npm run verify` calls. It answers one
 * question: do the files in this repository still match the hashes the browser
 * will enforce? A mismatch means either a bad merge or someone editing a vendored
 * file by hand, and both are worth failing a build over.
 *
 * WHY IT CHECKS THE NOTICES
 *
 * These bytes are committed, so this repository redistributes them, and both MIT
 * and BSD-3-Clause require the notice to travel with the copy. Two of the three
 * files carry no notice of their own: signals-core.mjs has no header at all and
 * tailwind-browser.js contains only the banner string it injects into compiled
 * CSS. LICENSES.md is therefore where the notices live, and it is checked the
 * same way the bytes are: against the LICENSE of the exact pinned version in
 * node_modules, because a notice nobody verifies drifts away from the code it
 * covers on the first upgrade. The production build carries its own generated
 * THIRD_PARTY_LICENSES.md; this covers the source-delivery path, which ships
 * these files verbatim and runs no build at all.
 *
 * WHY IT CHECKS EVERY APPLICATION
 *
 * The vendored bytes live with the library, but the hashes the browser enforces
 * live in each application's index.html, because that is where the import map is.
 * The invariant is therefore "every application that mounts this /lib agrees with
 * it", and checking one index.html would not see two of them disagreeing.
 *
 * The fetch mode refuses to write anything whose downloaded bytes do not match the
 * hash already recorded, so upgrading a dependency is a two-step operation with the
 * new hash in a diff a human approves. ADR-0032.
 *
 * Uses only node:crypto, node:fs and global fetch. Nothing from npm.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { REPO, apps, readText } from '../../cli/layout.mjs';
import {
  IMPORT_MAP_FILE,
  VENDOR,
  importMapText,
  vendorReferences,
} from '../../cli/package/interface.mjs';

const shouldFetch = process.argv.includes('--fetch');
const acceptNew = process.argv.includes('--accept-new');
const writeLicenses = process.argv.includes('--write-licenses');

/** @type {string[]} */
const problems = [];

const provenancePath = join(VENDOR, 'provenance.json');
const provenance = JSON.parse(await readText(provenancePath));

const applications = await apps();
if (applications.length === 0) {
  console.error('No application found: nothing declares the hashes the browser enforces.');
  process.exit(1);
}

/**
 * Per application, the `/lib/vendor/...` URLs it references and the hash it
 * declares for each.
 *
 * @type {Array<{ name: string, referenced: Map<string, string | undefined> }>}
 */
const declared = [];
for (const app of applications) {
  const html = await readText(join(app.dir, 'index.html'));
  declared.push({ name: app.name, referenced: vendorReferences(html, `${app.name}/index.html`) });
}

/**
 * @param {Buffer | Uint8Array} bytes
 * @returns {string}
 */
function sri(bytes) {
  return `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
}

let changed = false;

for (const entry of provenance.files) {
  const label = `${entry.package}@${entry.version}`;
  const path = join(VENDOR, entry.file);
  const servedAs = `/lib/vendor/${entry.file}`;

  // The hashes that must agree: every application's index.html (enforced by the
  // browser), provenance.json (documentation), and the bytes on disk (what ships).
  // An application that does not reference a vendored file at all is not a
  // problem — @tailwindcss/browser is development-only and an application may
  // legitimately ship the compiled stylesheet instead.
  for (const { name, referenced } of declared) {
    if (!referenced.has(servedAs)) continue;
    const inApp = referenced.get(servedAs);
    if (inApp === undefined) {
      problems.push(
        `${name}/index.html references ${servedAs} with no integrity hash. Without one the ` +
          `browser will load whatever bytes are there, and the vendored copy stops being a control.`,
      );
    } else if (inApp !== entry.integrity) {
      problems.push(
        `Hash disagreement for ${servedAs}\n    ${name}/index.html: ${inApp}\n` +
          `    provenance.json:  ${entry.integrity}`,
      );
    }
  }

  if (shouldFetch) {
    const response = await fetch(entry.url);
    if (!response.ok) {
      problems.push(`${entry.url} returned ${String(response.status)}.`);
      continue;
    }
    const downloaded = new Uint8Array(await response.arrayBuffer());
    const actual = sri(downloaded);

    if (actual !== entry.integrity) {
      if (!acceptNew) {
        problems.push(
          `${entry.url} no longer matches its recorded hash.\n` +
            `    recorded:   ${entry.integrity}\n    downloaded: ${actual}\n` +
            `    Nothing was written. If this change is expected, re-run with --accept-new ` +
            `and update the hash in every application's index.html in the same commit.`,
        );
        continue;
      }
      console.log('  new  %s\n       %s -> %s', label, entry.integrity, actual);
      entry.integrity = actual;
      entry.bytes = downloaded.byteLength;
      changed = true;
    }

    await writeFile(path, downloaded);
    console.log('  got  %s %s bytes', label.padEnd(28), String(downloaded.byteLength).padStart(7));
  }

  let bytes;
  try {
    // Raw bytes, not text: the hash is over what the server sends, and a utf8
    // round-trip through a string is not guaranteed to reproduce it byte for byte.
    bytes = await readFile(path);
  } catch {
    problems.push(
      `source/lib/vendor/${entry.file} is missing. Run \`npm run vendor -- --fetch\` to download it.`,
    );
    continue;
  }

  const actual = sri(bytes);
  if (actual !== entry.integrity) {
    problems.push(
      `source/lib/vendor/${entry.file} does not match its hash. The browser will refuse to load ` +
        `it.\n    expected: ${entry.integrity}\n    actual:   ${actual}`,
    );
    continue;
  }
  if (bytes.byteLength !== entry.bytes) {
    problems.push(
      `source/lib/vendor/${entry.file} is ${String(bytes.byteLength)} bytes, provenance says ${String(entry.bytes)}.`,
    );
    continue;
  }

  if (!shouldFetch) {
    const users = declared.filter(({ referenced }) => referenced.has(servedAs)).length;
    console.log(
      '  ok   %s %s bytes, hash matches, %s of %s app(s)',
      label.padEnd(28),
      String(bytes.byteLength).padStart(7),
      String(users),
      String(declared.length),
    );
  }
}

/* ── The notices that ship with the bytes ──────────────────────────────── */

const licensesPath = join(VENDOR, 'LICENSES.md');

/**
 * The heading that identifies one vendored file's notice. Carries the file, the
 * package and the version so that a section can never silently outlive the bytes
 * it covers: an upgrade changes the heading, and the check below then looks for a
 * section that is not there.
 *
 * @param {Record<string, unknown>} entry
 * @returns {string}
 */
function noticeHeading(entry) {
  return `## ${String(entry.file)} — ${String(entry.package)} ${String(entry.version)} (${String(entry.license)})`;
}

/**
 * The packages whose code one vendored file contains. `lit-all.min.js` is a
 * bundle of four, and naming only the one it is published under would leave three
 * copyright holders unacknowledged.
 *
 * @param {Record<string, unknown>} entry
 * @returns {string[]}
 */
function covered(entry) {
  return Array.isArray(entry.licenseCovers)
    ? entry.licenseCovers.map(String)
    : [String(entry.package)];
}

/**
 * One package's declared SPDX identifier and license text, read from the exact
 * version npm installed. `null` when it is absent, which is the fresh-clone case:
 * this file's whole point is that the repository works without node_modules, so a
 * missing one weakens the check to "a section exists" rather than failing it.
 *
 * @param {string} packageName
 * @returns {Promise<{ license: string, text: string } | null>}
 */
async function installedNotice(packageName) {
  const dir = join(REPO, 'node_modules', ...packageName.split('/'));
  try {
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    const text = await readFile(join(dir, 'LICENSE'), 'utf8');
    return { license: String(manifest.license), text: text.trim() };
  } catch {
    return null;
  }
}

/** @type {Array<{ heading: string, body: string }>} */
const sections = [];
let installedSeen = 0;

for (const entry of provenance.files) {
  if (typeof entry.license !== 'string' || entry.license === '') {
    problems.push(
      `provenance.json entry for ${String(entry.file)} declares no license. Every vendored file ` +
        `is redistributed by this repository, so every one of them needs its notice.`,
    );
    continue;
  }

  const packages = covered(entry);
  /** @type {string[]} */
  const texts = [];
  for (const packageName of packages) {
    const installed = await installedNotice(packageName);
    if (installed === null) continue;
    installedSeen += 1;
    if (installed.license !== entry.license) {
      problems.push(
        `License disagreement for ${packageName}\n    provenance.json:            ${String(entry.license)}\n` +
          `    node_modules/package.json:  ${installed.license}`,
      );
      continue;
    }
    if (!texts.includes(installed.text)) texts.push(installed.text);
  }

  const shared =
    packages.length > 1
      ? `Bundles ${packages.join(', ')}. One notice, because they share it.\n\n`
      : '';
  sections.push({ heading: noticeHeading(entry), body: `${shared}${texts.join('\n\n')}` });
}

const licensesText =
  `# Third-party notices for source/lib/vendor\n\n` +
  `These files are committed, so this repository redistributes them, and both MIT and\n` +
  `BSD-3-Clause require the notice below to travel with the copy. Applications served\n` +
  `straight from source get the notice from this file; a production artifact gets its\n` +
  `own generated THIRD_PARTY_LICENSES.md instead.\n\n` +
  `Generated by \`npm run vendor -- --write-licenses\` from the LICENSE of the exact\n` +
  `pinned version in node_modules. \`npm run vendor\` fails when the two disagree.\n` +
  `source/lib/vendor/provenance.json records where each file came from.\n\n` +
  `${sections.map(({ heading, body }) => `${heading}\n\n${body}\n`).join('\n')}`;

if (writeLicenses) {
  if (installedSeen === 0) {
    problems.push(
      `--write-licenses needs node_modules: the notices are copied from the LICENSE of each ` +
        `pinned version, not typed here. Run npm install first.`,
    );
  } else {
    await writeFile(licensesPath, licensesText);
    console.log('\nsource/lib/vendor/LICENSES.md written from node_modules.');
  }
} else {
  let committed = null;
  try {
    committed = await readFile(licensesPath, 'utf8');
  } catch {
    problems.push(
      `source/lib/vendor/LICENSES.md is missing, so the vendored bytes are redistributed with ` +
        `no notice. Run \`npm run vendor -- --write-licenses\`.`,
    );
  }

  if (committed !== null) {
    let agrees = true;
    for (const { heading } of sections) {
      if (committed.includes(heading)) continue;
      agrees = false;
      problems.push(
        `source/lib/vendor/LICENSES.md has no section "${heading}". A vendored file whose ` +
          `notice is absent or names another version is redistributed without one.`,
      );
    }
    if (installedSeen > 0 && committed !== licensesText) {
      agrees = false;
      problems.push(
        `source/lib/vendor/LICENSES.md does not match the LICENSE files of the pinned versions ` +
          `in node_modules. Run \`npm run vendor -- --write-licenses\` and commit the diff.`,
      );
    }
    if (agrees) {
      console.log(
        '  ok   %s %s section(s), %s',
        'LICENSES.md'.padEnd(28),
        String(sections.length),
        installedSeen === 0 ? 'no node_modules to check against' : 'text matches node_modules',
      );
    }
  }
}

if (changed && acceptNew) {
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  // The published fragment carries the same hashes, so it is stale the moment the
  // bytes change. Regenerated here rather than left for the next `npm run verify`
  // to complain about: it is the library's own file, and this is the command that
  // changed what it describes.
  await writeFile(IMPORT_MAP_FILE, await importMapText());
  console.log(
    '\nprovenance.json and source/lib/importmap.json updated. Paste the new fragment into every ' +
      "application's index.html before committing.\nA version changed, so the notices did too: " +
      'run `npm run vendor -- --write-licenses` and commit that diff in the same change.',
  );
}

if (problems.length > 0) {
  console.error('\n%d problem(s):\n', problems.length);
  for (const problem of problems) console.error('  - %s\n', problem);
  process.exit(1);
}

console.log('\nVendored dependencies verified.');
