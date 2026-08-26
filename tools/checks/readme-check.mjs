/**
 * The contract tables in docs/reference/project-index.md, generated from the project
 * model and checked.
 *
 *   node tools/checks/readme-check.mjs            fail if a generated section drifted
 *   node tools/checks/readme-check.mjs --write    rewrite the generated sections
 *   node tools/checks/readme-check.mjs --file X   operate on X instead of the default
 *
 * WHY THIS EXISTS
 *
 * The reference pages carry tables of tags, modules, templates and `uses` relationships.
 * Restating those by hand is how a manual starts lying: an element renamed in one commit
 * stays right in the source and wrong in the document nobody re-read. Every fact in a
 * generated block comes from the same model the template checker and the verifier read,
 * so the document cannot hold a second opinion about what exists.
 *
 * The default target is a page rather than the README because the README is an interface
 * and a generated index is not part of one. `--file` is how any other page
 * carries a block.
 *
 * Prose stays hand-written. Only the blocks between the markers are owned here:
 *
 *   <!-- generated:elements -->  … <!-- /generated:elements -->
 *
 * WHAT IT REFUSES
 *
 * A missing marker, a duplicate marker, an unterminated block, and a generated name this
 * tool does not produce. All four mean the document and the generator disagree about what
 * is generated, which is the failure this check exists to make loud.
 *
 * Every refusal is returned as a `Diagnostic`, never printed here: the reporting is
 * cli/diagnostics/index.mjs's, so `--json` costs this file nothing and a suite can assert
 * which marker was wrong rather than that something was. ADR-0072.
 *
 * No network, no npm install: it reads source and writes one file.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { error, info, outputFormat, report } from '../../cli/diagnostics/index.mjs';
import { apps, readText, repoPath, REPO } from '../../cli/layout.mjs';
import { readProject } from '../../cli/project-model/index.mjs';

/** @import { Diagnostic } from '../../cli/diagnostics/types.js' */
/** @import { ProjectModel } from '../../cli/project-model/types.js' */

const OPEN = /<!-- generated:([a-z-]+) -->/gu;

/** The page the generated contract tables live on, unless `--file` says otherwise. */
const DEFAULT_TARGET = 'docs/reference/project-index.md';

/**
 * Element records the collection and the library publish, without test source.
 *
 * A fixture element defined inside a suite is part of what the page defines — the checker
 * needs it — and is not part of anybody's interface, so it is documented nowhere.
 *
 * @param {ProjectModel} model
 */
function publishedElements(model) {
  return [...model.elements.values()]
    .filter((record) => {
      const path = repoPath(record.module);
      return path.startsWith('source/') && !path.includes('/test/');
    })
    .sort((left, right) => left.tag.localeCompare(right.tag));
}

/** @param {string[][]} rows @param {string[]} head */
function table(head, rows) {
  const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
  for (const row of rows) lines.push(`| ${row.join(' | ')} |`);
  return lines.join('\n');
}

/** @param {string | null} path */
function code(path) {
  return path === null ? '—' : `\`${path}\``;
}

/**
 * Every generated block, keyed by the name in its marker.
 *
 * @returns {Promise<Map<string, string>>}
 */
async function sections() {
  const discovered = await apps();

  /** @type {ProjectModel[]} */
  const models = [];
  for (const app of discovered) models.push(await readProject(app));

  const documented = models;

  // Elements under source/ are identical in every application: the library and the
  // collection are one copy on one origin. The first model answers for all of them.
  const reference = models[0];
  if (reference === undefined) throw new Error('No application found to read.');

  const elements = table(
    ['Tag', 'Class', 'Module', 'Template', 'Uses', 'Reactive properties', 'Observed attributes'],
    publishedElements(reference).map((record) => [
      `\`${record.tag}\``,
      `\`${record.className}\``,
      code(repoPath(record.module)),
      code(record.template === null ? null : repoPath(record.template)),
      record.uses.length === 0 ? '—' : record.uses.map((use) => `\`${use.tag ?? use.className}\``).join(', '),
      String(record.properties.length),
      // Not the same count: a property may declare `attribute: false`, and an element that
      // is configuration rather than a component declares attributes and no properties.
      record.observedAttributes === null ? '?' : String(record.observedAttributes.length),
    ]),
  );

  const globals = table(
    ['Name', 'Module'],
    [...reference.globals.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, global]) => [`\`${name}\``, code(repoPath(global.module))]),
  );

  const applications = table(
    ['Application', 'Entry module', 'Prefixes it declares', 'Templates it owns', 'Elements it declares'],
    documented.map((model) => {
      const root = `${repoPath(model.app.dir)}/`;
      const owned = [...model.templates.values()].filter((template) => repoPath(template.path).startsWith(root));
      const declared = [...model.elements.values()].filter((record) => repoPath(record.module).startsWith(root));
      return [
        `\`${model.app.name}\``,
        code(model.entry === null ? null : repoPath(model.entry)),
        Object.keys(model.prefixes)
          .sort()
          .map((prefix) => `\`${prefix}\``)
          .join(' '),
        String(owned.length),
        String(declared.length),
      ];
    }),
  );

  return new Map([
    ['elements', elements],
    ['globals', globals],
    ['applications', applications],
  ]);
}

/**
 * Split a document into its generated blocks.
 *
 * A marker this cannot make sense of is a diagnostic rather than a throw, and the
 * blocks it did read are still returned: a document with two broken markers should
 * report both in one run.
 *
 * @param {string} text
 * @param {string} where
 * @returns {{ found: Array<{ name: string, start: number, end: number, body: string }>, diagnostics: Diagnostic[] }}
 */
function blocks(text, where) {
  /** @type {Array<{ name: string, start: number, end: number, body: string }>} */
  const found = [];
  /** @type {Diagnostic[]} */
  const diagnostics = [];
  const seen = new Set();
  OPEN.lastIndex = 0;
  for (let match = OPEN.exec(text); match !== null; match = OPEN.exec(text)) {
    const name = match[1] ?? '';
    if (seen.has(name)) {
      diagnostics.push(
        error('docs/duplicate-marker', `<!-- generated:${name} --> appears twice.`, { file: where }),
      );
      continue;
    }
    seen.add(name);
    const close = `<!-- /generated:${name} -->`;
    const end = text.indexOf(close, match.index);
    if (end === -1) {
      diagnostics.push(
        error('docs/unterminated-marker', `<!-- generated:${name} --> is never closed.`, {
          file: where,
        }),
      );
      continue;
    }
    found.push({
      name,
      start: match.index + match[0].length,
      end,
      body: text.slice(match.index + match[0].length, end).trim(),
    });
  }
  return { found, diagnostics };
}

/**
 * @param {string} text
 * @param {Map<string, string>} expected
 * @param {string} where
 * @param {boolean} write
 * @returns {{ out: string | null, drifted: string[], diagnostics: Diagnostic[] }}
 */
function rewrite(text, expected, where, write) {
  const { found: present, diagnostics } = blocks(text, where);

  for (const block of present) {
    if (!expected.has(block.name)) {
      diagnostics.push(
        error(
          'docs/unknown-section',
          `<!-- generated:${block.name} --> is not a section this tool generates.`,
          { file: where },
        ),
      );
    }
  }
  for (const name of expected.keys()) {
    if (!present.some((block) => block.name === name)) {
      diagnostics.push(
        error(
          'docs/missing-marker',
          `no <!-- generated:${name} --> block. Add the markers where the table belongs.`,
          { file: where },
        ),
      );
    }
  }

  // A document whose markers do not describe the sections this tool owns cannot be
  // rewritten into one that does, so nothing is returned to write.
  if (diagnostics.length > 0) return { out: null, drifted: [], diagnostics };

  let out = text;
  /** @type {string[]} */
  const drifted = [];
  // Backwards, so an earlier replacement cannot move a later block's offsets.
  for (const block of [...present].reverse()) {
    const body = /** @type {string} */ (expected.get(block.name));
    if (body !== block.body) drifted.push(block.name);
    out = `${out.slice(0, block.start)}\n\n${body}\n\n${out.slice(block.end)}`;
  }
  drifted.reverse();

  if (drifted.length === 0) {
    diagnostics.push(
      info('docs/current', 'generated sections are current', { file: where }),
    );
  } else if (write) {
    diagnostics.push(
      info('docs/rewritten', `rewrote ${drifted.join(', ')}`, { file: where }),
    );
  } else {
    diagnostics.push(
      error(
        'docs/generated-drift',
        `${drifted.join(', ')} no longer match the project model.\n` +
          `    Run \`npm run docs:write\` and commit the result.`,
        { file: where },
      ),
    );
  }

  return { out, drifted, diagnostics };
}

/**
 * @param {{ file?: string, write?: boolean }} [options]
 * @returns {Promise<{ diagnostics: Diagnostic[], drifted: string[], text: string | null }>}
 */
export async function checkReadme(options = {}) {
  const file = options.file ?? join(REPO, DEFAULT_TARGET);
  const text = await readText(file);
  const write = options.write === true;
  // The absolute path, spelled by cli/diagnostics rather than here: a page inside the
  // repository is reported relative to it and one outside keeps its full path, and that
  // is one rule for every check rather than a `show()` helper per tool.
  const { out, drifted, diagnostics } = rewrite(text, await sections(), file, write);
  if (write && out !== null && out !== text) await writeFile(file, out, 'utf8');
  return { diagnostics, drifted, text: out };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const write = process.argv.includes('--write');
  const index = process.argv.indexOf('--file');
  const file = index === -1 ? undefined : process.argv[index + 1];

  const { diagnostics } = await checkReadme({ file, write });
  process.exitCode = report(diagnostics, {
    format: outputFormat(),
    summary: `The generated sections of ${file ?? DEFAULT_TARGET} come from the project model.`,
  });
}
