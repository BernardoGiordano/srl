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
 * The marker grammar, and what it refuses, belong to `generated.mjs`: this file owns the
 * tables, not the mechanics of a page that carries them.
 *
 * No network, no npm install: it reads source and writes one file.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { outputFormat, report } from '../../cli/diagnostics/index.mjs';
import { apps, readText, repoPath, REPO } from '../../cli/layout.mjs';
import { readProject } from '../../cli/project-model/index.mjs';
import { rewriteGenerated, table } from './generated.mjs';

/** @import { Diagnostic } from '../../cli/diagnostics/types.js' */

/** @import { ProjectModel } from '../../cli/project-model/types.js' */

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
    ['Tag', 'Class', 'Module', 'Template', 'Uses', 'Public inputs', 'Internal state', 'Observed attributes', 'Events', 'Projection'],
    publishedElements(reference).map((record) => [
      `\`${record.tag}\``,
      `\`${record.className}\``,
      code(repoPath(record.module)),
      code(record.template === null ? null : repoPath(record.template)),
      record.uses.length === 0 ? '—' : record.uses.map((use) => `\`${use.tag ?? use.className}\``).join(', '),
      record.surfaceKnown ? String(record.properties.length) : `${String(record.properties.length)}+`,
      record.surfaceKnown ? String(record.state.length) : `${String(record.state.length)}+`,
      // Not the same count: a property may declare `attribute: false`, and an element that
      // is configuration rather than a component declares attributes and no properties.
      record.observedAttributes === null ? '?' : String(record.observedAttributes.length),
      record.eventsKnown ? String(record.events.length) : `${String(record.events.length)}+`,
      record.slots === null ? '?' : String(record.slots.length),
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
  const { out, drifted, diagnostics } = rewriteGenerated(text, await sections(), {
    file,
    write,
    command: 'npm run docs:write',
  });
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
