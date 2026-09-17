/**
 * The generated tables in docs/reference/, checked against what they are generated from.
 *
 *   node tools/checks/readme-check.mjs            fail if a generated section drifted
 *   node tools/checks/readme-check.mjs --write    rewrite the generated sections
 *   node tools/checks/readme-check.mjs --file X   operate on X, a copy of one page
 *
 * Three pages carry generated blocks.
 *
 *   project-index.md     tags, modules, templates and `uses`, from the project model
 *   template-dialect.md  the template dialect, from source/lib/core/template/
 *   diagnostic-codes.md  every `srl check` code, from cli/diagnostics/catalog.mjs
 *
 * Restating those facts by hand is how a manual starts lying, because an element renamed
 * in one commit stays right in the source and wrong in the document nobody re-read. Every
 * fact in a generated block comes from the module the runtime or the toolchain reads, so
 * the document cannot hold a second opinion. These pages ship inside both packages, so a
 * drifted table would mislead a consumer at the installed version.
 *
 * `--file` picks the generator by the file name, so a copy of a page elsewhere is checked
 * as that page.
 *
 * Prose stays hand-written. Only the blocks between the markers are owned here.
 *
 *   <!-- generated:elements -->  … <!-- /generated:elements -->
 *
 * The marker grammar, and what it refuses, belong to `generated.mjs`. This file owns the
 * tables rather than the mechanics of a page that carries them.
 *
 * No network and no npm install. It reads source and writes one file.
 */

import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { catalogEntries } from '../../cli/diagnostics/catalog.mjs';
import { error, outputFormat, report } from '../../cli/diagnostics/index.mjs';
import { apps, readText, repoPath, REPO } from '../../cli/layout.mjs';
import { readProject } from '../../cli/project-model/index.mjs';
import { dialectSections } from './dialect-reference.mjs';
import { rewriteGenerated, table } from './generated.mjs';

/** @import { Diagnostic } from '../../cli/diagnostics/types.js' */

/** @import { ProjectModel } from '../../cli/project-model/types.js' */


/**
 * Element records the collection and the library publish, without test source.
 *
 * A fixture element defined inside a suite is part of what the page defines, because
 * the checker needs it, and is not part of anybody's interface, so it is documented
 * nowhere.
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
 * The project index blocks, keyed by the name in its marker.
 *
 * @returns {Promise<Map<string, string>>}
 */
async function projectSections() {
  const discovered = await apps();

  /** @type {ProjectModel[]} */
  const models = [];
  for (const app of discovered) models.push(await readProject(app));

  const documented = models;

  // Elements under source/ are identical in every application, because the library and
  // the collection are one copy on one origin. The first model answers for all of
  // them.
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
      // Not the same count, because a property may declare `attribute: false` and an
      // element that is configuration rather than a component declares attributes and
      // no properties.
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
 * The diagnostic code table, in catalogue order.
 *
 * @returns {Map<string, string>}
 */
function codeSections() {
  const rows = catalogEntries().map(([code, summary]) => [`\`${code}\``, summary]);
  return new Map([['codes', table(['Code', 'Meaning'], rows)]]);
}

/**
 * Every page with generated blocks, and what generates them.
 *
 * @type {ReadonlyArray<{ page: string, sections: () => Promise<Map<string, string>> | Map<string, string> }>}
 */
const PAGES = [
  { page: 'docs/reference/project-index.md', sections: projectSections },
  { page: 'docs/reference/template-dialect.md', sections: dialectSections },
  { page: 'docs/reference/diagnostic-codes.md', sections: codeSections },
];

/**
 * Hold one page against its generator.
 *
 * @param {string} file
 * @param {() => Promise<Map<string, string>> | Map<string, string>} sections
 * @param {boolean} write
 * @returns {Promise<{ diagnostics: Diagnostic[], drifted: string[], text: string | null }>}
 */
async function checkPage(file, sections, write) {
  const text = await readText(file);
  // The absolute path, spelled by cli/diagnostics rather than here. A page inside the
  // repository is reported relative to it and one outside keeps its full path, which is
  // one rule for every check rather than a `show()` helper per tool.
  const { out, drifted, diagnostics } = rewriteGenerated(text, await sections(), {
    file,
    write,
    command: 'npm run docs:write',
  });
  if (write && out !== null && out !== text) await writeFile(file, out, 'utf8');
  return { diagnostics, drifted, text: out };
}

/**
 * Check every generated page, or the one page `file` is a copy of.
 *
 * `text` is the rewritten page when one file was checked, and null otherwise.
 *
 * @param {{ file?: string, write?: boolean }} [options]
 * @returns {Promise<{ diagnostics: Diagnostic[], drifted: string[], text: string | null }>}
 */
export async function checkReadme(options = {}) {
  const write = options.write === true;

  if (options.file !== undefined) {
    const name = basename(options.file);
    const owner = PAGES.find(({ page }) => basename(page) === name);
    if (owner === undefined) {
      return {
        diagnostics: [
          error(
            'docs/unknown-page',
            `no generator owns a page named ${name}. The pages are ${PAGES.map(({ page }) => basename(page)).join(', ')}.`,
            { file: options.file },
          ),
        ],
        drifted: [],
        text: null,
      };
    }
    return checkPage(options.file, owner.sections, write);
  }

  /** @type {Diagnostic[]} */
  const diagnostics = [];
  /** @type {string[]} */
  const drifted = [];
  for (const { page, sections } of PAGES) {
    const checked = await checkPage(join(REPO, page), sections, write);
    diagnostics.push(...checked.diagnostics);
    drifted.push(...checked.drifted);
  }
  return { diagnostics, drifted, text: null };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const write = process.argv.includes('--write');
  const index = process.argv.indexOf('--file');
  const file = index === -1 ? undefined : process.argv[index + 1];

  const { diagnostics } = await checkReadme({ file, write });
  process.exitCode = report(diagnostics, {
    format: outputFormat(),
    summary: `The generated sections of ${file ?? 'docs/reference/'} match what generates them.`,
  });
}
