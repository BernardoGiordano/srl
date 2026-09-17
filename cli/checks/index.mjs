/**
 * Every check in one process, reported as one list.
 *
 *   srl check [<subject>...] [--app <name>] [--json]
 *   srl check messages --write
 *   srl check --codes [--json]
 *
 * The subjects are `project`, `types`, `templates`, `importmap` and `messages`, and
 * naming none runs all five. Each check returns `Diagnostic[]` and prints nothing, so
 * this module joins the lists, orders them by application, and hands them to
 * cli/diagnostics for one report and one exit code. ADR-0072, ADR-0120.
 *
 * Each application's project model is read once and shared by every check that needs
 * it. The build calls `checkProject()` as well, with the subjects that decide whether
 * its artifact is correct.
 *
 * `--write` lets the messages check add unanswered keys. It is refused next to any other
 * subject, because a full run should not edit bundles on the side. `--codes` prints the
 * catalogue in cli/diagnostics/catalog.mjs and checks nothing.
 */

import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { formatCatalog, formatCatalogJson } from '../diagnostics/catalog.mjs';
import { error, hasErrors, info, outputFormat, report } from '../diagnostics/index.mjs';
import { REPO, apps, selectedApp } from '../layout.mjs';
import { isTestSource, readProject } from '../project-model/index.mjs';
import { checkImportMaps } from './importmap-check.mjs';
import { checkMessages } from './message-check.mjs';
import { checkTemplates } from './template-check.mjs';
import { checkTypes } from './type-check.mjs';

/** @import { Diagnostic } from '../diagnostics/types.js' */
/** @import { ProjectModel } from '../project-model/types.js' */

/** @typedef {{ name: string, dir: string }} Application */
/** @typedef {'project' | 'types' | 'templates' | 'importmap' | 'messages'} Subject */
/** @typedef {(app: Application) => Promise<ProjectModel>} ReadModel */

/** Every subject, in the order a run reports them. */
export const SUBJECTS = /** @type {readonly Subject[]} */ (
  Object.freeze(['project', 'types', 'templates', 'importmap', 'messages'])
);

/** How the summary line names each subject. */
const LABELS = /** @type {Record<Subject, string>} */ ({
  project: 'the project model',
  types: 'types',
  templates: 'templates',
  importmap: 'import maps',
  messages: 'messages',
});

/**
 * A model reader that reads each application once.
 *
 * @param {ReadModel} read
 * @returns {ReadModel}
 */
function readOnce(read) {
  /** @type {Map<string, Promise<ProjectModel>>} */
  const models = new Map();
  return (app) => {
    let model = models.get(app.dir);
    if (model === undefined) {
      model = read(app);
      models.set(app.dir, model);
    }
    return model;
  };
}

/**
 * The project model's own findings for one application.
 *
 * Errors are reported wherever they are, because the build refuses every one. Warnings
 * are reported only for the application's own source outside its tests. The rest
 * describe how the library registers its elements, or a suite that declares something
 * invalid on purpose, and the editor shows those in the file.
 *
 * @param {Application} app
 * @param {ProjectModel} model
 * @returns {Diagnostic[]}
 */
function projectFindings(app, model) {
  const found = model.diagnostics.filter((diagnostic) => {
    if (diagnostic.severity === 'error') return true;
    if (diagnostic.file === null) return false;
    const file = resolve(REPO, diagnostic.file);
    return file.startsWith(app.dir + sep) && !isTestSource(file, [app.dir]);
  });
  if (!hasErrors(found)) {
    found.push(
      info(
        'project/read',
        `${String(model.elements.size)} element(s) and ${String(model.templates.size)} ` +
          `template(s) read`,
        { group: app.name },
      ),
    );
  }
  return found;
}

/**
 * The findings ordered by application, keeping each check's order inside one.
 *
 * The text report prints a heading whenever the group changes, so this is what makes
 * one application's findings from five checks read as one block. Findings about the
 * repository as a whole come first.
 *
 * @param {Diagnostic[]} found
 * @param {readonly Application[]} selected
 * @returns {Diagnostic[]}
 */
function byApplication(found, selected) {
  const order = new Map(selected.map((app, index) => [app.name, index]));
  /** @param {Diagnostic} diagnostic */
  const rank = (diagnostic) =>
    diagnostic.group === null ? -1 : (order.get(diagnostic.group) ?? selected.length);
  return [...found].sort((left, right) => rank(left) - rank(right));
}

/**
 * Run the named checks over the given applications.
 *
 * @param {{
 *   subjects?: readonly Subject[],
 *   apps?: Application[],
 *   readModel?: ReadModel,
 *   write?: boolean,
 * }} [options]
 *   `subjects` defaults to all of them, and `apps` to every application in the
 *   repository. `readModel` defaults to `readProject()`, and the run calls it once per
 *   application whichever reader it is. `write` passes through to the messages check.
 * @returns {Promise<Diagnostic[]>}
 */
export async function checkProject(options = {}) {
  const subjects = new Set(options.subjects ?? SUBJECTS);
  const selected = options.apps ?? (await apps());
  const readModel = readOnce(options.readModel ?? readProject);

  // The type check reads tsconfig.json and needs no application. Every other subject
  // has nothing to do without one.
  if (selected.length === 0 && [...subjects].some((subject) => subject !== 'types')) {
    return [
      error(
        'check/no-application',
        `No application with an index.html was found in ${REPO}. An application is any ` +
          `directory in the repository root with an index.html. If this repository keeps ` +
          `its applications elsewhere, point SRL_ROOT at the root that holds them.`,
      ),
    ];
  }

  /** @type {Diagnostic[]} */
  const found = [];
  if (subjects.has('project')) {
    for (const app of selected) found.push(...projectFindings(app, await readModel(app)));
  }
  if (subjects.has('types')) found.push(...checkTypes());
  if (subjects.has('templates')) {
    found.push(...(await checkTemplates({ apps: selected, readModel })));
  }
  if (subjects.has('importmap')) found.push(...(await checkImportMaps({ apps: selected })));
  if (subjects.has('messages')) {
    found.push(...(await checkMessages({ apps: selected, readModel, write: options.write })));
  }
  return byApplication(found, selected);
}

/**
 * What the command line asks for, or the findings that say why it cannot be run.
 *
 * @param {readonly string[]} args the words after `srl check`
 * @returns {Promise<{
 *   subjects: readonly Subject[],
 *   apps: Application[] | undefined,
 *   write: boolean,
 *   refusals: Diagnostic[],
 * }>}
 */
async function commandLine(args) {
  /** @type {string[]} */
  const words = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === '--app') index += 1;
    else if (!arg.startsWith('-')) words.push(arg);
  }

  /** @type {Diagnostic[]} */
  const refusals = [];
  const known = /** @type {readonly string[]} */ (SUBJECTS);
  for (const word of words.filter((candidate) => !known.includes(candidate))) {
    refusals.push(
      error(
        'check/unknown-subject',
        `"${word}" is not something srl check can check. The subjects are ` +
          `${SUBJECTS.join(', ')}, and naming none checks all of them.`,
      ),
    );
  }
  const subjects = words.length === 0 ? SUBJECTS : SUBJECTS.filter((subject) => words.includes(subject));

  const write = args.includes('--write');
  if (write && (subjects.length !== 1 || subjects[0] !== 'messages')) {
    refusals.push(
      error(
        'check/write-outside-messages',
        '--write adds missing keys to message bundles, so it runs only as ' +
          '`srl check messages --write`.',
      ),
    );
  }

  /** @type {Application[] | undefined} */
  let selected;
  if (args.includes('--app')) {
    try {
      selected = [await selectedApp()];
    } catch (cause) {
      refusals.push(
        error('check/unknown-application', cause instanceof Error ? cause.message : String(cause)),
      );
    }
  }

  return { subjects, apps: selected, write, refusals };
}

/**
 * The line a text report ends with when nothing failed.
 *
 * @param {readonly Subject[]} subjects
 * @returns {string}
 */
function summary(subjects) {
  const names = subjects.map((subject) => LABELS[subject]);
  const last = names.pop();
  const list = names.length === 0 ? String(last) : `${names.join(', ')} and ${String(last)}`;
  return `Checked ${list}. Nothing failed.`;
}

/* ── As a command ──────────────────────────────────────────────────────────
 *
 * Guarded, so importing this module stays free of output and exit codes.
 */

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  const format = outputFormat();

  // `exitCode` rather than `exit()`, because a pipe on macOS takes writes asynchronously
  // and exiting at once can cut a long JSON document short.
  if (args.includes('--codes')) {
    process.stdout.write(format === 'json' ? formatCatalogJson() : formatCatalog());
  } else {
    const { subjects, apps: selected, write, refusals } = await commandLine(args);
    const found =
      refusals.length > 0 ? refusals : await checkProject({ subjects, apps: selected, write });
    process.exitCode = report(found, { format, summary: summary(subjects) });
  }
}
