/**
 * Fetch and verify the library's vendored runtime dependencies.
 *
 * No application needs this script. `source/lib/vendor` is committed, so a clone
 * runs with no npm install, no network and no tooling. This exists for the two
 * maintenance operations that do need the network:
 *
 *   node tools/vendor.mjs                verify committed bytes against the hashes
 *   node tools/vendor.mjs --fetch        re-download and verify before writing
 *   node tools/vendor.mjs --fetch --accept-new
 *                                        accept new bytes and print the new hash
 *
 * The verify mode is offline and is what `npm run verify` calls. It answers one
 * question: do the files in this repository still match the hashes the browser
 * will enforce? A mismatch means either a bad merge or someone editing a vendored
 * file by hand, and both are worth failing a build over.
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

import { apps, readText } from '../layout.mjs';
import {
  IMPORT_MAP_FILE,
  VENDOR,
  importMapText,
  vendorReferences,
} from '../package/interface.mjs';

const shouldFetch = process.argv.includes('--fetch');
const acceptNew = process.argv.includes('--accept-new');

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

if (changed && acceptNew) {
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  // The published fragment carries the same hashes, so it is stale the moment the
  // bytes change. Regenerated here rather than left for the next `npm run verify`
  // to complain about: it is the library's own file, and this is the command that
  // changed what it describes.
  await writeFile(IMPORT_MAP_FILE, await importMapText());
  console.log(
    '\nprovenance.json and source/lib/importmap.json updated. Paste the new fragment into every ' +
      "application's index.html before committing.",
  );
}

if (problems.length > 0) {
  console.error('\n%d problem(s):\n', problems.length);
  for (const problem of problems) console.error('  - %s\n', problem);
  process.exit(1);
}

console.log('\nVendored dependencies verified.');
