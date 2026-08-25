/**
 * One interpretation of this project's source.
 *
 *   node cli/project-model/index.mjs [--app example] [--element ui-table] [--json]
 *
 * WHAT IT OWNS
 *
 * Which custom elements exist, the class and module that declare each one, the markup
 * each renders, which tags each may name, which templates exist and which definition
 * claims them, which names templates may use without an import, and every declaration
 * static analysis cannot read. Applications and their mounts come from cli/layout.mjs,
 * which stays the owner of physical layout; this module consumes it rather than
 * re-deriving it.
 *
 * WHY IT EXISTS
 *
 * Three tools answered these questions separately and agreed only by luck. ADR-0038.
 * One model also gives an AI agent or an editor the same answer the build uses:
 * `--json` is the whole index, `--element` is one element and its dependencies.
 *
 * WHAT IT DELIBERATELY DOES NOT MODEL
 *
 * Routes, injection tokens, remote grants and message keys. Custom-element and template
 * identity is the fact three consumers already needed; the rest would be a model with one
 * consumer, which is a data structure looking for a reason.
 */

import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPO, apps, exists, readText, repoPath, selectedApp, walk } from '../layout.mjs';
import {
  COMPONENTS,
  LIB,
  extractImportMap,
  fileToUrl,
  urlToFile,
} from '../package/interface.mjs';
import { parseModule } from './parse.mjs';

/**
 * @import { Application, ElementRecord, ModuleRecord, ProjectDiagnostic, ProjectIndex,
 *   ProjectModel, TemplateRecord, UsesEntry } from './types.js'
 */

/**
 * Everything one application's source declares.
 *
 * Every path in the model is absolute, because its consumers open files. The JSON
 * projection is where paths become repository-relative and sortable.
 *
 * `roots` exists for the model's own tests, which point it at a fixture project instead of
 * this repository. Every consumer uses the default: the library, the shared collection and
 * the application, which is the dependency direction the verifier enforces.
 *
 * @param {Application} app
 * @param {{ roots?: string[] }} [options]
 * @returns {Promise<ProjectModel>}
 */
export async function readProject(app, options = {}) {
  const roots = options.roots ?? [LIB, COMPONENTS, app.dir];
  const indexHtml = await readText(join(app.dir, 'index.html'));
  const prefixes = importPrefixes(app, indexHtml);
  const entry = entryModule(app, indexHtml);

  // Tests included: a fixture that registers an element is part of what the page defines,
  // and a checker that cannot see it reports the fixture's own markup as unknown elements.
  /** @type {string[]} */
  const files = [];
  for (const root of roots) files.push(...(await walk(root, /\.js$/u)));

  /** @type {Map<string, ModuleRecord>} */
  const modules = new Map();
  /** @type {Map<string, ElementRecord>} */
  const elements = new Map();
  /** @type {Map<string, import('./types.js').TemplateGlobal>} */
  const globals = new Map();
  /** @type {ProjectDiagnostic[]} */
  const diagnostics = [];
  /** @type {Array<{ record: ElementRecord, uses: string[] }>} */
  const pending = [];

  for (const file of [...new Set(files)].sort()) {
    const parsed = await parseModule(file, prefixes);
    modules.set(parsed.path, {
      path: parsed.path,
      imports: parsed.imports,
      sideEffectImports: parsed.sideEffectImports,
      classes: parsed.classes,
      storage: parsed.storage,
    });

    for (const entry of parsed.dynamic) {
      diagnostics.push({
        kind: 'dynamic',
        // A suite declaring something unreadable is a suite doing its job: several assert
        // that the runtime rejects a definition a static tool could never have accepted.
        severity: isTestSource(parsed.path, roots) ? 'note' : entry.severity,
        file: parsed.path,
        message: entry.message,
      });
    }
    for (const [name, exportName] of parsed.globals) {
      globals.set(name, { module: parsed.path, exportName });
    }

    for (const definition of parsed.definitions) {
      const template =
        definition.kind === 'customElements.define' ||
        (definition.templateDeclared && definition.template === undefined)
          ? null
          : resolve(
              dirname(parsed.path),
              definition.template ?? `${basename(parsed.path, '.js')}.html`,
            );

      /** @type {ElementRecord} */
      const record = {
        tag: definition.tag,
        className: definition.className,
        module: parsed.path,
        exported: parsed.classes.get(definition.className) ?? false,
        kind: definition.kind,
        template,
        templateDeclared: definition.templateDeclared,
        templateExists: template === null ? null : await exists(template),
        uses: [],
        usesTags: [],
        properties: parsed.properties.get(definition.className) ?? [],
        // `?? null` and not `?? []`: a class this module did not declare at top level —
        // one built by a factory, or handed to `customElements.define` from elsewhere —
        // has a surface nothing here read, and "unread" must not read as "observes
        // nothing".
        observedAttributes: parsed.attributes.get(definition.className) ?? null,
      };

      const existing = elements.get(definition.tag);
      if (existing !== undefined) {
        // The runtime refuses this outright — a tag is one component's identity — so a
        // second claim is a rename that left the old declaration behind, or two modules
        // that will fight over whichever loads first.
        diagnostics.push({
          kind: 'duplicate-tag',
          severity: isTestSource(parsed.path, roots) ? 'note' : 'error',
          file: parsed.path,
          message:
            `<${definition.tag}> is declared by both ${show(existing.module)} ` +
            `(${existing.className}) and ${show(parsed.path)} (${definition.className}). ` +
            'A tag is one component\'s identity, and whichever module loads second throws.',
        });
        continue;
      }

      elements.set(definition.tag, record);
      if (definition.uses.length > 0) pending.push({ record, uses: definition.uses });
    }
  }

  // `uses` resolves the way the browser resolves it: through the import that brought the
  // class in, or the declaring module for a local class. Second pass, because an entry
  // may name a class declared in a file that had not been read yet.
  for (const { record, uses } of pending) {
    const imports = modules.get(record.module)?.imports;
    for (const className of uses) {
      const module = imports?.get(className) ?? record.module;
      const target = [...elements.values()].find(
        (candidate) => candidate.module === module && candidate.className === className,
      );
      /** @type {UsesEntry} */
      const entry = { className, module, tag: target?.tag ?? null };
      record.uses.push(entry);
      if (target === undefined) {
        diagnostics.push({
          kind: 'unresolved-uses',
          severity: isTestSource(record.module, roots) ? 'note' : 'error',
          file: record.module,
          message:
            `<${record.tag}> lists ${className} in \`uses\`, but nothing in ${show(module)} ` +
            'defines a custom element with that class. Its markup cannot name that element, ' +
            'and the browser throws when the definition runs.',
        });
      }
    }
    record.usesTags = [
      ...new Set([record.tag, ...record.uses.map((use) => use.tag).filter(isTag)]),
    ].sort((left, right) => left.localeCompare(right));
  }
  for (const record of elements.values()) {
    if (record.usesTags.length === 0) record.usesTags = [record.tag];
  }

  // And the elements a module makes exist by importing them for the side effect.
  //
  // `uses` is how a component declares another component, and it is not available
  // for a plain `customElements.define` element: `uses` resolves each entry to a
  // component definition and throws on a class that has none. For those, running
  // the module is the definition, so the import is the declaration — and without
  // this the checker reports the element as missing from a `uses` list that could
  // not accept it, which is advice that breaks the application at runtime.
  for (const record of elements.values()) {
    const sideEffects = modules.get(record.module)?.sideEffectImports;
    if (sideEffects === undefined || sideEffects.size === 0) continue;

    const reachable = [...elements.values()]
      .filter((candidate) => candidate.kind === 'customElements.define')
      .filter((candidate) => sideEffects.has(candidate.module))
      .map((candidate) => candidate.tag);
    if (reachable.length === 0) continue;

    record.usesTags = [...new Set([...record.usesTags, ...reachable])].sort((left, right) =>
      left.localeCompare(right),
    );
  }

  const templates = await readTemplates(app, elements, roots);

  return { app, prefixes, entry, modules, elements, globals, templates, diagnostics };
}

/**
 * Every template file this application can reach, and the definition that claims it.
 *
 * One walk, one rule, two consumers. The bundler ships what is here and not a fixture;
 * the verifier compares a bundle against the same set, which is what stops the two from
 * disagreeing about a test template again.
 *
 * An application's own root is searched through `src/` and `remotes/` rather than whole:
 * its index.html is the page, not a component's markup, and a bundle that keyed it would
 * seed the template cache with the document.
 *
 * @param {Application} app
 * @param {Map<string, ElementRecord>} elements
 * @param {string[]} roots
 * @returns {Promise<Map<string, TemplateRecord>>}
 */
async function readTemplates(app, elements, roots) {
  /** @type {Map<string, string>} */
  const claims = new Map();
  for (const record of elements.values()) {
    if (record.template !== null) claims.set(record.template, record.tag);
  }

  /** @type {string[]} */
  const found = [];
  for (const root of roots) {
    const directories =
      root === app.dir ? [join(root, 'src'), join(root, 'remotes')] : [root];
    for (const directory of directories) found.push(...(await walk(directory, /\.html$/u)));
  }

  /** @type {Map<string, TemplateRecord>} */
  const templates = new Map();
  for (const path of [...new Set(found)].sort()) {
    templates.set(path, {
      path,
      url: fileToUrl(app.dir, path),
      claimedBy: claims.get(path) ?? null,
      // A suite's fixture markup is fetched by a test in the browser, so it stays a real
      // file — but shipping it inside an application's bundle would put test bytes in
      // production.
      fixture: isTestSource(path, roots),
    });
  }
  return templates;
}

/**
 * The import-map prefixes that name source in this repository, as directories.
 *
 * Read from the application's own import map rather than hardcoded, because the map is
 * what the browser resolves against: a prefix added there reaches every static tool with
 * no second edit. Vendored bare specifiers are skipped — they name files, not prefixes.
 *
 * @param {Application} app
 * @param {string} indexHtml
 * @returns {Record<string, string>}
 */
function importPrefixes(app, indexHtml) {
  const { imports } = extractImportMap(indexHtml, `${app.name}/index.html`);
  /** @type {Record<string, string>} */
  const prefixes = {};
  for (const [specifier, url] of Object.entries(imports)) {
    if (!specifier.endsWith('/') || !url.startsWith('/')) continue;
    // `resolve` rather than the raw join: a prefix maps to a directory, and a trailing
    // separator would make the same directory two different strings to compare against.
    prefixes[specifier] = resolve(urlToFile(app.dir, url));
  }
  return prefixes;
}

/**
 * The module index.html loads, which is where the application starts.
 *
 * @param {Application} app
 * @param {string} indexHtml
 * @returns {string | null}
 */
function entryModule(app, indexHtml) {
  for (const tag of indexHtml.matchAll(/<script\b[^>]*>/gu)) {
    if (!/\stype=["']module["']/u.test(tag[0])) continue;
    const source = /\ssrc=["']([^"']+)["']/u.exec(tag[0])?.[1];
    if (source !== undefined && source.startsWith('/')) return urlToFile(app.dir, source);
  }
  return null;
}

/**
 * Templates a definition names that are not on disk.
 *
 * A 404 on one route and nothing anywhere else, which is why it is a build failure rather
 * than a runtime surprise.
 *
 * @param {ProjectModel} model
 * @returns {ElementRecord[]}
 */
export function missingTemplates(model) {
  return [...model.elements.values()].filter((record) => record.templateExists === false);
}

/**
 * Markup beside a component module that no definition claims.
 *
 * Always a leftover from a rename or a deletion, and invisible: the old file keeps being
 * served, keeps passing every check that reads it, and renders nowhere. Only a
 * module-sibling name counts — an `.html` that is not any module's sibling is a partial
 * or a fixture, not an abandoned template.
 *
 * @param {ProjectModel} model
 * @returns {TemplateRecord[]}
 */
export function orphanTemplates(model) {
  /** @type {Set<string>} */
  const siblings = new Set();
  for (const path of model.modules.keys()) {
    siblings.add(join(dirname(path), `${basename(path, '.js')}.html`));
  }
  return [...model.templates.values()].filter(
    (template) => template.claimedBy === null && siblings.has(template.path),
  );
}

/**
 * The templates an application ships: everything reachable, minus test fixtures.
 *
 * @param {ProjectModel} model
 * @returns {TemplateRecord[]}
 */
export function shippedTemplates(model) {
  return [...model.templates.values()].filter(
    (template) => !template.fixture && template.url !== null,
  );
}

/**
 * The model as JSON: sorted, repository-relative, and stable across machines.
 *
 * Stability is the point. This is what a README table, an editor and an agent read, so two
 * runs on two checkouts must produce identical bytes — no absolute path, no `Map`
 * iteration order, no timestamps.
 *
 * @param {ProjectModel} model
 * @returns {ProjectIndex}
 */
export function projectIndex(model) {
  /** @param {string | null} path @returns {string | null} */
  const rel = (path) => (path === null ? null : repoPath(path));

  return {
    app: model.app.name,
    root: repoPath(model.app.dir),
    entry: rel(model.entry),
    prefixes: Object.fromEntries(
      Object.entries(model.prefixes)
        .map(([prefix, dir]) => [prefix, repoPath(dir)])
        .sort(([left], [right]) => String(left).localeCompare(String(right))),
    ),
    elements: [...model.elements.values()]
      .sort((left, right) => left.tag.localeCompare(right.tag))
      .map((record) => ({
        tag: record.tag,
        className: record.className,
        module: repoPath(record.module),
        exported: record.exported,
        kind: record.kind,
        template: rel(record.template),
        uses: record.uses.map((use) => use.tag ?? `${use.className} (unresolved)`).sort(),
        properties: record.properties,
        observedAttributes: record.observedAttributes,
      })),
    globals: [...model.globals.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, global]) => ({
        name,
        module: repoPath(global.module),
        exportName: global.exportName,
      })),
    templates: [...model.templates.values()]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((template) => ({
        path: repoPath(template.path),
        url: template.url,
        claimedBy: template.claimedBy,
      })),
    diagnostics: model.diagnostics
      .map((diagnostic) => ({
        kind: diagnostic.kind,
        severity: diagnostic.severity,
        file: repoPath(diagnostic.file),
        message: diagnostic.message.split(REPO + sep).join(''),
      }))
      .sort((left, right) => `${left.file}${left.message}`.localeCompare(`${right.file}${right.message}`)),
  };
}

/**
 * One element and everything a caller has to know to use it, as text.
 *
 * The question an agent or an editor asks first — "what is <ui-table>, where is it, what
 * can I bind, what does its markup need" — answered without reading a 1,300-line module.
 *
 * @param {ProjectModel} model
 * @param {string} tag
 * @returns {string}
 */
export function describeElement(model, tag) {
  const record = model.elements.get(tag.toLowerCase());
  if (record === undefined) {
    const known = [...model.elements.keys()].sort().join(', ');
    return `No element <${tag}> in ${model.app.name}.\nKnown: ${known}`;
  }

  const lines = [
    `<${record.tag}>  ${record.className}${record.exported ? '' : ' (not exported)'}`,
    `  module    ${show(record.module)}`,
    `  template  ${
      record.template === null
        ? record.kind === 'customElements.define'
          ? 'none (bare customElements.define)'
          : 'none (template: false)'
        : `${show(record.template)}${record.templateExists === false ? ' — MISSING' : ''}${
            record.templateDeclared ? ' (declared)' : ' (module sibling)'
          }`
    }`,
  ];

  if (record.properties.length > 0) {
    lines.push(`  properties ${record.properties.join(', ')}`);
  }
  if (record.observedAttributes === null) {
    lines.push('  attributes unknown (the declaration is not statically readable)');
  } else if (record.observedAttributes.length > 0) {
    lines.push(`  attributes ${record.observedAttributes.join(', ')}`);
  }
  if (record.uses.length > 0) {
    lines.push('  uses');
    for (const use of record.uses) {
      lines.push(
        `    ${use.className.padEnd(24)} ${
          use.tag === null ? 'UNRESOLVED' : `<${use.tag}>`
        }  ${use.module === null ? '' : show(use.module)}`,
      );
    }
  }

  const usedBy = [...model.elements.values()]
    .filter((candidate) => candidate.uses.some((use) => use.tag === record.tag))
    .map((candidate) => `<${candidate.tag}>`)
    .sort();
  if (usedBy.length > 0) lines.push(`  used by   ${usedBy.join(' ')}`);

  return lines.join('\n');
}

/**
 * Diagnostics that must fail a build, as opposed to the ones that describe how the
 * framework registers elements or what a suite deliberately declared wrong.
 *
 * @param {ProjectModel} model
 * @returns {ProjectDiagnostic[]}
 */
export function projectErrors(model) {
  return model.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
}

/**
 * Test source: a suite, or anything inside a `test/` directory of the project it belongs
 * to.
 *
 * Relative to the root the file was found under, never absolute, and that is not a
 * detail: this repository keeps the model's own fixture projects in `cli/test/fixtures`,
 * so an absolute-path check calls every file in them test source and downgrades every
 * error the fixtures exist to produce. The same trap waits for any checkout under a
 * directory somebody named `test`.
 *
 * @param {string} file
 * @param {readonly string[]} roots
 * @returns {boolean}
 */
function isTestSource(file, roots) {
  const root = roots.find((candidate) => file.startsWith(candidate + sep)) ?? REPO;
  const inside = relative(root, file);
  return inside.split(sep).includes('test') || inside.endsWith('.test.js');
}

/**
 * @param {string | null} path
 * @returns {string}
 */
function show(path) {
  return path === null ? 'unknown' : relative(REPO, path).split(sep).join('/');
}

/**
 * @param {string | null} value
 * @returns {value is string}
 */
function isTag(value) {
  return value !== null;
}

/* ── As a command ──────────────────────────────────────────────────────────
 *
 * Guarded, so importing this module stays free of output and exit codes.
 */

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await selectedApp();
  const model = await readProject(app);
  const elementIndex = process.argv.indexOf('--element');

  if (elementIndex !== -1) {
    const tag = process.argv[elementIndex + 1];
    if (tag === undefined) {
      console.error('usage: node cli/project-model/index.mjs --element <tag>');
      process.exit(1);
    }
    console.log(describeElement(model, tag));
  } else if (process.argv.includes('--json')) {
    console.log(JSON.stringify(projectIndex(model), null, 2));
  } else {
    const all = await apps();
    const notes = model.diagnostics.length - projectErrors(model).length;
    console.log(
      `${model.app.name}: ${String(model.elements.size)} element(s), ` +
        `${String(model.templates.size)} template(s), ${String(model.globals.size)} template ` +
        `global(s), ${String(projectErrors(model).length)} error(s), ${String(notes)} note(s). ` +
        `Applications: ${all.map((one) => one.name).join(', ')}.\n` +
        'usage: node cli/project-model/index.mjs [--app <name>] [--element <tag> | --json]',
    );
  }
  for (const diagnostic of projectErrors(model)) console.error(`  error: ${diagnostic.message}`);
  process.exitCode = projectErrors(model).length > 0 ? 1 : 0;
}
