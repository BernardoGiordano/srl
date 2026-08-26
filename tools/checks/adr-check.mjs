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
 * Every refusal is a `Diagnostic` carrying the file and the line, returned rather than
 * printed: cli/diagnostics/index.mjs owns the report, so `--json` costs this file nothing
 * and a malformed record no longer stops the run before the next one is read. ADR-0072.
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

import { error, info, outputFormat, report } from '../../cli/diagnostics/index.mjs';
import { REPO, apps, readText, repoPath, walk } from '../../cli/layout.mjs';

/** @import { Diagnostic } from '../../cli/diagnostics/types.js' */

/**
 * One record, as this tool reads it.
 *
 * @typedef {object} AdrRecord
 * @property {string} id `ADR-0042`, the identifier a source comment cites.
 * @property {number} number The same, as a number, for ordering.
 * @property {string} title
 * @property {string} status The whole field: the state, plus the successor a superseded record names.
 * @property {string} affects
 * @property {string} path Repository-relative.
 * @property {string} file Basename, which is what the index links to.
 */

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
 * One record, parsed, or the reasons it could not be.
 *
 * Collected rather than thrown, and the record comes back `null` when anything was
 * wrong: a half-read record is a citation that resolves to a surprise, and a run that
 * stopped at the first malformed file is a run somebody repeats once per file.
 *
 * @param {string} path
 * @param {string} text
 * @returns {{ record: AdrRecord | null, diagnostics: Diagnostic[] }}
 */
function parseRecord(path, text) {
  const name = repoPath(path);
  const file = basename(path);
  /** @type {Diagnostic[]} */
  const diagnostics = [];
  /** @param {string} code @param {string} message */
  const refuse = (code, message) => diagnostics.push(error(code, message, { file: path }));

  const named = FILENAME.exec(file);
  if (named === null) {
    refuse('adr/filename', 'a record is named NNNN-kebab-title.md.');
    return { record: null, diagnostics };
  }

  const heading = HEADING.exec(text);
  if (heading === null) {
    refuse('adr/no-heading', 'no `# ADR-NNNN: Title` heading.');
    return { record: null, diagnostics };
  }
  if (heading[1] !== named[1]) {
    refuse(
      'adr/number-mismatch',
      `the heading says ADR-${heading[1]}, the filename says ${named[1]}.`,
    );
  }

  /** @type {Record<string, string>} */
  const fields = {};
  for (const field of ['Status', 'Date', 'Affects']) {
    const match = FIELD(field).exec(text);
    if (match === null) refuse('adr/missing-field', `no \`- ${field}:\` field.`);
    else fields[field] = (match[1] ?? '').trim();
  }

  // The first word is the state; anything after it is the successor a superseded record
  // has to name, which is the only reason the field is not a bare keyword.
  const status = fields.Status ?? '';
  const state = (status.split(/\s+/u)[0] ?? '').toLowerCase();
  if (fields.Status !== undefined && !STATUSES.has(state)) {
    refuse('adr/unknown-status', `status "${status}" is not one of ${[...STATUSES].join(', ')}.`);
  }
  if (state === 'superseded' && !/\bADR-\d{4}\b/u.test(status)) {
    refuse(
      'adr/superseded-without-successor',
      'a superseded record names the record that replaced it.',
    );
  }
  if (fields.Date !== undefined && !/^\d{4}-\d{2}-\d{2}$/u.test(fields.Date)) {
    refuse('adr/malformed-date', `date "${fields.Date}" is not YYYY-MM-DD.`);
  }

  for (const section of SECTIONS) {
    if (!text.includes(`\n${section}\n`)) {
      refuse('adr/missing-section', `no \`${section}\` section.`);
    }
  }

  if (diagnostics.length > 0) return { record: null, diagnostics };

  return {
    record: {
      id: `ADR-${named[1]}`,
      number: Number(named[1]),
      title: (heading[2] ?? '').trim(),
      status,
      affects: fields.Affects ?? '',
      path: name,
      file,
    },
    diagnostics,
  };
}

/**
 * Every record, by id, in number order, and every reason one was refused.
 *
 * @param {string} [dir] The directory to read. The suite points it at a fixture.
 * @returns {Promise<{ records: Map<string, AdrRecord>, diagnostics: Diagnostic[] }>}
 */
export async function readRecords(dir = ADR_DIR) {
  const files = (await walk(dir, /\.md$/u))
    .filter((path) => basename(path) !== 'README.md' && !TEMPLATE.test(basename(path)))
    .sort();

  /** @type {Map<string, AdrRecord>} */
  const records = new Map();
  /** @type {Diagnostic[]} */
  const diagnostics = [];

  for (const path of files) {
    const parsed = parseRecord(path, await readText(path));
    diagnostics.push(...parsed.diagnostics);
    const record = parsed.record;
    if (record === null) continue;
    const existing = records.get(record.id);
    if (existing !== undefined) {
      diagnostics.push(
        error('adr/duplicate-number', `${record.id} is already ${existing.path}.`, { file: path }),
      );
      continue;
    }
    records.set(record.id, record);
  }
  return { records, diagnostics };
}

/**
 * The index table, generated so it cannot disagree with the directory.
 *
 * @param {Map<string, AdrRecord>} records
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
 * @returns {Promise<{ diagnostics: Diagnostic[], records: Map<string, AdrRecord> }>}
 */
export async function checkAdrs() {
  const { records, diagnostics } = await readRecords();

  const cited = await sourceFiles();
  const documents = (await walk(join(REPO, 'docs'), /\.md$/u)).concat(join(REPO, 'README.md'));
  let citations = 0;

  for (const path of [...cited, ...documents]) {
    const name = repoPath(path);
    if (RULE_OWNERS.has(name)) continue;
    const text = await readText(path);
    const lines = text.split('\n');

    for (const [index, line] of lines.entries()) {
      const at = { file: path, line: index + 1 };

      CITATION.lastIndex = 0;
      for (let match = CITATION.exec(line); match !== null; match = CITATION.exec(line)) {
        const id = `ADR-${match[1]}`;
        if (id === 'ADR-0000') continue;
        citations += 1;
        if (!records.has(id)) {
          diagnostics.push(
            error('adr/unresolved-citation', `cites ${id}, which no record defines.`, at),
          );
        }
      }

      if (!name.startsWith('docs/') && name !== 'README.md' && SECTION_CITATION.test(line)) {
        diagnostics.push(
          error(
            'adr/section-citation',
            'cites a README section number. Cite a record or an anchor.',
            at,
          ),
        );
      }

      if (PROJECT_PHASE.test(line)) {
        diagnostics.push(
          error('adr/project-phase', 'project-phase vocabulary in a permanent file.', at),
        );
      }
    }
  }

  diagnostics.push(
    info('adr/records', `docs/adr: ${String(records.size)} record(s) read`),
    ...(diagnostics.some((diagnostic) => diagnostic.code === 'adr/unresolved-citation')
      ? []
      : [info('adr/citations', `${String(citations)} citation(s) resolve to a record`)]),
  );

  return { diagnostics, records };
}

/**
 * Rewrite the generated block in the index.
 *
 * @param {Map<string, AdrRecord>} records
 * @returns {Promise<{ changed: boolean, diagnostics: Diagnostic[] }>}
 */
async function writeIndex(records) {
  const text = await readText(INDEX);
  const open = '<!-- generated:adr-index -->';
  const close = '<!-- /generated:adr-index -->';
  const start = text.indexOf(open);
  const end = text.indexOf(close);
  if (start === -1 || end === -1) {
    return {
      changed: false,
      diagnostics: [
        error('adr/no-index-block', `no ${open} … ${close} block.`, { file: INDEX }),
      ],
    };
  }

  const out = `${text.slice(0, start + open.length)}\n\n${indexTable(records)}\n\n${text.slice(end)}`;
  if (out === text) return { changed: false, diagnostics: [] };
  await writeFile(INDEX, out, 'utf8');
  return { changed: true, diagnostics: [] };
}

/**
 * True when the index on disk matches the directory.
 *
 * @param {Map<string, AdrRecord>} records
 * @returns {Promise<boolean>}
 */
async function indexIsCurrent(records) {
  const text = await readText(INDEX);
  return text.includes(indexTable(records));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const write = process.argv.includes('--write');
  const { diagnostics, records } = await checkAdrs();

  if (write) {
    const written = await writeIndex(records);
    diagnostics.push(
      ...written.diagnostics,
      info('adr/index', `index ${written.changed ? 'rewritten' : 'current'}`, { file: INDEX }),
    );
  } else if (!(await indexIsCurrent(records))) {
    diagnostics.push(
      error(
        'adr/index-drift',
        'the index no longer lists the records on disk.\n' +
          '    Run `npm run docs:adr:write` if only the index drifted.',
        { file: INDEX },
      ),
    );
  }

  process.exitCode = report(diagnostics, {
    format: outputFormat(),
    summary: 'Every record is well formed and every citation resolves.',
  });
}
