/**
 * The decision records in docs/adr, and the citations that reach them.
 *
 *   node tools/checks/adr-check.mjs            fail on a broken record or citation
 *   node tools/checks/adr-check.mjs --write    rewrite the generated index
 *
 * A source comment may say why a line is the way it is. It may not carry the narrative
 * of how the decision was reached: that is a record with an identity, and an identity a
 * comment can cite without restating. This tool is the enforcement half of that rule —
 * README.md has stated it since the repository had one reader, and a policy no check
 * reads is a policy the next commit forgets.
 *
 * WHAT IT REFUSES
 *
 * A record whose number disagrees with its filename or its heading, a duplicate number,
 * a missing Status/Date/Affects field, a missing Context/Decision/Consequences section,
 * a superseded record that does not name its successor, and a cited `ADR-0000` that no
 * file defines. Each one means a citation somewhere resolves to nothing, which is the
 * failure mode a stable identifier exists to prevent.
 *
 * It also refuses two spellings that make a citation rot. A README section number moves
 * the moment a section is inserted above it, so source cites records and anchors, never
 * `§12`. And project-phase vocabulary — the phase a change happened in, the name of a
 * review that produced it — dates a permanent file against a calendar nobody keeps.
 *
 * No network, no npm install: it reads the repository and writes one file.
 */

import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { REPO, apps, readText, repoPath, walk } from '../../cli/layout.mjs';

/** Records live here. One file per decision, `NNNN-kebab-title.md`. */
const ADR_DIR = join(REPO, 'docs/adr');

/** The index this tool generates, and the template it must not read as a record. */
const INDEX = join(ADR_DIR, 'README.md');
const TEMPLATE = /^0000-/u;

const FILENAME = /^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u;
const HEADING = /^# ADR-(\d{4}): (.+)$/mu;
/** @param {string} name @returns {RegExp} */
const FIELD = (name) => new RegExp(`^- ${name}: (.+)$`, 'mu');
const STATUSES = new Set(['proposed', 'accepted', 'superseded', 'reversed']);
const SECTIONS = ['## Context', '## Decision', '## Consequences'];

/** Every citation of a record, anywhere. `ADR-0009`, and nothing looser. */
const CITATION = /\bADR-(\d{4})\b/gu;

/**
 * A README section number, cited from source. `§12` and `README §12` both rot the
 * moment a section is inserted above the one they mean.
 */
const SECTION_CITATION = /(?:README )?§\s?\d+/u;

/** The phase a change happened in, or the review that produced it. Dates the file. */
const PROJECT_PHASE = /\b(?:[Pp]hase \d+|review2|review-2|the reshape)\b/u;

/**
 * This tool and its suite have to spell the forbidden shapes out to look for them, so
 * they are the two files the shapes are allowed in.
 */
const RULE_OWNERS = new Set(['tools/checks/adr-check.mjs', 'tools/test/adr-check.test.mjs']);

/**
 * The directories whose files may cite a record, and must not cite a section number.
 *
 * @returns {Promise<string[]>}
 */
async function sourceFiles() {
  /** @type {string[]} */
  const found = [];
  const dirs = ['source', 'cli', 'tools', ...(await apps()).map((app) => app.name)];
  for (const dir of dirs) {
    found.push(...(await walk(join(REPO, dir), /\.(?:js|mjs)$/u)));
  }
  return found.filter((path) => !repoPath(path).includes('/vendor/'));
}

/**
 * One record, parsed. Throws with the file named on anything malformed, because a
 * half-read record is a citation that resolves to a surprise.
 *
 * @param {string} path
 * @param {string} text
 * @returns {{ id: string, number: number, title: string, status: string, affects: string, path: string, file: string }}
 */
function parseRecord(path, text) {
  const name = repoPath(path);
  const file = basename(path);

  const named = FILENAME.exec(file);
  if (named === null) {
    throw new Error(`${name}: a record is named NNNN-kebab-title.md.`);
  }

  const heading = HEADING.exec(text);
  if (heading === null) {
    throw new Error(`${name}: no \`# ADR-NNNN: Title\` heading.`);
  }
  if (heading[1] !== named[1]) {
    throw new Error(`${name}: the heading says ADR-${heading[1]}, the filename says ${named[1]}.`);
  }

  /** @type {Record<string, string>} */
  const fields = {};
  for (const field of ['Status', 'Date', 'Affects']) {
    const match = FIELD(field).exec(text);
    if (match === null) throw new Error(`${name}: no \`- ${field}:\` field.`);
    fields[field] = (match[1] ?? '').trim();
  }

  // The first word is the state; anything after it is the successor a superseded record
  // has to name, which is the only reason the field is not a bare keyword.
  const status = fields.Status ?? '';
  const state = (status.split(/\s+/u)[0] ?? '').toLowerCase();
  if (!STATUSES.has(state)) {
    throw new Error(`${name}: status "${status}" is not one of ${[...STATUSES].join(', ')}.`);
  }
  if (state === 'superseded' && !/\bADR-\d{4}\b/u.test(status)) {
    throw new Error(`${name}: a superseded record names the record that replaced it.`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(fields.Date ?? '')) {
    throw new Error(`${name}: date "${fields.Date}" is not YYYY-MM-DD.`);
  }

  for (const section of SECTIONS) {
    if (!text.includes(`\n${section}\n`)) throw new Error(`${name}: no \`${section}\` section.`);
  }

  return {
    id: `ADR-${named[1]}`,
    number: Number(named[1]),
    title: (heading[2] ?? '').trim(),
    status,
    affects: fields.Affects ?? '',
    path: name,
    file,
  };
}

/**
 * Every record, by id, in number order.
 *
 * @param {string} [dir] The directory to read. The suite points it at a fixture.
 * @returns {Promise<Map<string, ReturnType<typeof parseRecord>>>}
 */
export async function readRecords(dir = ADR_DIR) {
  const files = (await walk(dir, /\.md$/u))
    .filter((path) => basename(path) !== 'README.md' && !TEMPLATE.test(basename(path)))
    .sort();

  /** @type {Map<string, ReturnType<typeof parseRecord>>} */
  const records = new Map();
  for (const path of files) {
    const record = parseRecord(path, await readText(path));
    const existing = records.get(record.id);
    if (existing !== undefined) {
      throw new Error(`${record.path}: ${record.id} is already ${existing.path}.`);
    }
    records.set(record.id, record);
  }
  return records;
}

/**
 * The index table, generated so it cannot disagree with the directory.
 *
 * @param {Map<string, ReturnType<typeof parseRecord>>} records
 * @returns {string}
 */
function indexTable(records) {
  const rows = [...records.values()].sort((left, right) => left.number - right.number);
  const lines = ['| Record | Decision | Status | Affects |', '|---|---|---|---|'];
  for (const record of rows) {
    lines.push(
      `| [${record.id}](${record.file}) | ${record.title} | ${record.status} | ${record.affects} |`,
    );
  }
  return lines.join('\n');
}

/**
 * Every problem this tool can see, as one list. Collected rather than thrown one at a
 * time: a run that reports the first broken citation and stops is a run somebody has to
 * repeat once per citation.
 *
 * @returns {Promise<{ problems: string[], records: Map<string, ReturnType<typeof parseRecord>> }>}
 */
export async function checkAdrs() {
  const records = await readRecords();
  /** @type {string[]} */
  const problems = [];

  const cited = await sourceFiles();
  const documents = (await walk(join(REPO, 'docs'), /\.md$/u)).concat(join(REPO, 'README.md'));

  for (const path of [...cited, ...documents]) {
    const name = repoPath(path);
    if (RULE_OWNERS.has(name)) continue;
    const text = await readText(path);
    const lines = text.split('\n');

    for (const [index, line] of lines.entries()) {
      CITATION.lastIndex = 0;
      for (let match = CITATION.exec(line); match !== null; match = CITATION.exec(line)) {
        const id = `ADR-${match[1]}`;
        if (id !== 'ADR-0000' && !records.has(id)) {
          problems.push(`${name}:${index + 1}: cites ${id}, which no record defines.`);
        }
      }

      if (!name.startsWith('docs/') && name !== 'README.md' && SECTION_CITATION.test(line)) {
        problems.push(
          `${name}:${index + 1}: cites a README section number. Cite a record or an anchor.`,
        );
      }

      if (PROJECT_PHASE.test(line)) {
        problems.push(`${name}:${index + 1}: project-phase vocabulary in a permanent file.`);
      }
    }
  }

  return { problems, records };
}

/**
 * Rewrite the generated block in the index.
 *
 * @param {Map<string, ReturnType<typeof parseRecord>>} records
 * @returns {Promise<boolean>} True when the file changed.
 */
async function writeIndex(records) {
  const text = await readText(INDEX);
  const open = '<!-- generated:adr-index -->';
  const close = '<!-- /generated:adr-index -->';
  const start = text.indexOf(open);
  const end = text.indexOf(close);
  if (start === -1 || end === -1) {
    throw new Error(`docs/adr/README.md: no ${open} … ${close} block.`);
  }

  const out = `${text.slice(0, start + open.length)}\n\n${indexTable(records)}\n\n${text.slice(end)}`;
  if (out === text) return false;
  await writeFile(INDEX, out, 'utf8');
  return true;
}

/**
 * True when the index on disk matches the directory.
 *
 * @param {Map<string, ReturnType<typeof parseRecord>>} records
 * @returns {Promise<boolean>}
 */
async function indexIsCurrent(records) {
  const text = await readText(INDEX);
  return text.includes(indexTable(records));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const write = process.argv.includes('--write');
  const { problems, records } = await checkAdrs();

  if (write) {
    const changed = await writeIndex(records);
    console.log(`  ok   docs/adr: ${records.size} records, index ${changed ? 'rewritten' : 'current'}`);
  } else if (!(await indexIsCurrent(records))) {
    problems.push('docs/adr/README.md: the index no longer lists the records on disk.');
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`  FAIL ${problem}`);
    console.error('       Run `npm run docs:adr:write` if only the index drifted.');
    process.exitCode = 1;
  } else if (!write) {
    console.log(`  ok   docs/adr: ${records.size} records, every citation resolves`);
  }
}
