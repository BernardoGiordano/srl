/**
 * One interpretation of this project's source.
 *
 *   node cli/project-model/index.mjs [--app example] [--element ui-table] [--json]
 *
 * It owns which custom elements exist, the class and module that declare each one,
 * public inputs and internal state across inheritance, events they dispatch,
 * projection buckets their markup renders, which tags each may name, which templates
 * exist and which definition claims them, which names templates may use without an
 * import, and every declaration static analysis cannot read. Applications and their
 * mounts come from cli/layout.mjs, and this module consumes them rather than
 * re-deriving physical layout.
 *
 * Three tools need these answers, and separately they agree only by luck. ADR-0038,
 * ADR-0093. One model also gives an AI agent or an editor the same answer the build
 * uses, where `--json` is the whole index and `--element` is one element and its
 * dependencies.
 *
 * It deliberately does not model routes, injection tokens or remote grants.
 * Custom-element and template identity is the fact three consumers already needed,
 * and the rest would be a model with one consumer, which is a data structure looking
 * for a reason.
 *
 * Message references are carried, and message meaning is not. A module record says
 * which keys its source names and where, because the parse that finds an element
 * definition is already reading those call sites. What a key resolves to, which
 * bundle owns it and whether it exists belong to cli/message-catalog/, which reads
 * this model rather than parsing the project a second time.
 */

import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFragment } from 'parse5';

import { StylesheetScopeError, scopeStylesheet } from '@srljs/core/lib/core/elements/style-scope.js';
import { INTERPOLATION } from '@srljs/core/lib/core/template/dialect.js';
import { error, warning } from '../diagnostics/index.mjs';
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
 * @import { Application, ElementRecord, ModelFinding, ModuleRecord, ProjectIndex,
 *   ProjectModel, TemplateRecord, UsesEntry } from './types.js'
 */
/** @import { Diagnostic } from '../diagnostics/types.js' */

/** @typedef {{
 *   properties: Map<string, import('./types.js').ElementProperty>,
 *   surfaceKnown: boolean,
 *   explicitAttributes: Set<string>,
 *   attributesKnown: boolean,
 *   events: Map<string, import('./types.js').ElementEvent>,
 *   eventsKnown: boolean,
 *   methods: Set<string>,
 * }} ResolvedSurface */
/** @typedef {{
 *   tagName?: string,
 *   attrs?: Array<{ name: string, value: string }>,
 *   childNodes?: ProjectionNode[],
 *   content?: ProjectionNode,
 * }} ProjectionNode */

/**
 * Everything one application's source declares.
 *
 * Every path in the model is absolute, because its consumers open files. The JSON
 * projection is where paths become repository-relative and sortable.
 *
 * `roots` exists for the model's own tests, which point it at a fixture project
 * instead of this repository. Every consumer uses the default, which is the library,
 * the shared collection and the application, in the dependency direction the
 * verifier enforces.
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

  // Tests included, because a fixture that registers an element is part of what the
  // page defines and a checker that cannot see it reports the fixture's own markup as
  // unknown elements. `.mjs` included, because the editor clients open it and the
  // template checker reads it, so a module this walk skips is a module whose elements
  // do not exist to any consumer.
  /** @type {string[]} */
  const files = [];
  for (const root of roots) files.push(...(await walk(root, /\.m?js$/u)));

  /** @type {Map<string, ModuleRecord>} */
  const modules = new Map();
  /** @type {Map<string, Awaited<ReturnType<typeof parseModule>>>} */
  const parsedModules = new Map();
  /** @type {Map<string, ElementRecord>} */
  const elements = new Map();
  /** @type {Map<string, import('./types.js').TemplateGlobal>} */
  const globals = new Map();
  /** @type {ModelFinding[]} */
  const findings = [];
  /** @type {Array<{ record: ElementRecord, uses: string[] }>} */
  const pending = [];

  for (const file of [...new Set(files)].sort()) {
    const parsed = await parseModule(file, prefixes);
    parsedModules.set(parsed.path, parsed);
    modules.set(parsed.path, {
      path: parsed.path,
      imports: parsed.imports,
      sideEffectImports: parsed.sideEffectImports,
      classes: parsed.classes,
      storage: parsed.storage,
      messages: parsed.messages,
      literals: parsed.literals,
    });

    for (const entry of parsed.dynamic) {
      findings.push({
        code: 'project/dynamic',
        // A suite declaring something unreadable is a suite doing its job, since
        // several assert that the runtime rejects a definition a static tool could
        // never have accepted.
        severity: isTestSource(parsed.path, roots) ? 'warning' : entry.severity,
        file: parsed.path,
        line: entry.line,
        column: entry.column,
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
              definition.template ?? `${basename(parsed.path, extname(parsed.path))}.html`,
            );
      const stylesheet = definition.styles
        ? join(dirname(parsed.path), `${basename(parsed.path, extname(parsed.path))}.css`)
        : null;

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
        stylesheet,
        stylesheetExists: stylesheet === null ? null : await exists(stylesheet),
        uses: [],
        usesTags: [],
        properties: [],
        state: [],
        propertyDeclarations: [],
        surfaceKnown: false,
        observedAttributes: null,
        events: [],
        eventsKnown: false,
        slots: null,
      };

      const existing = elements.get(definition.tag);
      if (existing !== undefined) {
        // The runtime refuses this outright, because a tag is one component's
        // identity. A second claim is a rename that left the old declaration
        // behind, or two modules that will fight over whichever loads first.
        findings.push({
          code: 'project/duplicate-tag',
          severity: isTestSource(parsed.path, roots) ? 'warning' : 'error',
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

  for (const finding of resolveElementSurfaces(elements, parsedModules)) {
    findings.push({
      ...finding,
      severity: isTestSource(finding.file, roots) ? 'warning' : finding.severity,
    });
  }

  // `uses` resolves the way the browser resolves it, through the import that brought
  // the class in, or the declaring module for a local class. Second pass, because an
  // entry may name a class declared in a file that had not been read yet.
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
        findings.push({
          code: 'project/unresolved-uses',
          severity: isTestSource(record.module, roots) ? 'warning' : 'error',
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
  // for a plain `customElements.define` element, because `uses` resolves each entry
  // to a component definition and throws on a class that has none. For those,
  // running the module is the definition, so the import is the declaration. Without
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
  await readProjectionSlots(elements);
  await readStylesheets(elements, findings, roots);

  const diagnostics = findings.map((finding) => asDiagnostic(app, finding));
  return { app, prefixes, entry, modules, elements, globals, templates, diagnostics };
}

/**
 * A model finding as a `Diagnostic`.
 *
 * The conversion comes last because the test-source rule above needs absolute paths,
 * and cli/diagnostics shortens them.
 *
 * @param {Application} app
 * @param {ModelFinding} finding
 * @returns {Diagnostic}
 */
function asDiagnostic(app, finding) {
  const make = finding.severity === 'error' ? error : warning;
  return make(finding.code, finding.message, {
    group: app.name,
    file: finding.file,
    line: finding.line,
    column: finding.column,
  });
}

/** Platform/framework roots add no application-declared reactive inputs of their own. */
const ELEMENT_ROOTS = new Set([
  'Element',
  'EventTarget',
  'HTMLElement',
  'LitElement',
  'ReactiveElement',
  'SVGElement',
]);

/** The reaction callbacks the browser calls on any custom element. */
const PLATFORM_METHODS = [
  'adoptedCallback',
  'attributeChangedCallback',
  'connectedCallback',
  'disconnectedCallback',
];

/** Lit's update cycle, which `ReactiveElement` and everything under it carries. */
const REACTIVE_METHODS = [
  ...PLATFORM_METHODS,
  'addController',
  'createRenderRoot',
  'firstUpdated',
  'getUpdateComplete',
  'performUpdate',
  'removeController',
  'requestUpdate',
  'scheduleUpdate',
  'shouldUpdate',
  'update',
  'updated',
  'willUpdate',
];

/**
 * The methods an element inherits from a root the walk stops at.
 *
 * Not a list of names the framework dislikes. It is the one place where a class this
 * model does not parse still contributes callable members, and a field covering one of
 * them is as fatal as a field covering `render`. Both interfaces are published and
 * stable, so the entries do not drift the way a rule of thumb would. A method an
 * element declares itself is read from its source, never from here.
 *
 * @type {Map<string, Set<string>>}
 */
const ROOT_METHODS = new Map();
ROOT_METHODS.set('Element', new Set(PLATFORM_METHODS));
ROOT_METHODS.set('HTMLElement', new Set(PLATFORM_METHODS));
ROOT_METHODS.set('SVGElement', new Set(PLATFORM_METHODS));
ROOT_METHODS.set('ReactiveElement', new Set(REACTIVE_METHODS));
// `render` is LitElement's: ReactiveElement has an update cycle and no markup.
ROOT_METHODS.set('LitElement', new Set([...REACTIVE_METHODS, 'render']));

/**
 * Resolve authored class facts into each registered Element. Lit inherits reactive
 * declarations even when a subclass supplies its own `properties`, and subclass entries
 * replace same-named parent entries. Callers receive that answer, not syntax fragments
 * they have to merge again.
 *
 * Inherited methods are resolved the same way, for the one question in `fieldsHiding`
 * below: which callable members a field could cover.
 *
 * @param {Map<string, ElementRecord>} elements
 * @param {Map<string, Awaited<ReturnType<typeof parseModule>>>} parsedModules
 * @returns {ModelFinding[]}
 */
function resolveElementSurfaces(elements, parsedModules) {
  /** @type {Map<string, ResolvedSurface>} */
  const cache = new Map();
  /** @type {ModelFinding[]} */
  const findings = [];
  /** Classes already reported on: one shared base class serves many tags. @type {Set<string>} */
  const reported = new Set();

  /** @param {string} module @param {string} className @param {Set<string>} [stack] @returns {ResolvedSurface} */
  const resolveClass = (module, className, stack = new Set()) => {
    const key = `${module}\0${className}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    if (stack.has(key)) return unknownSurface();

    const parsed = parsedModules.get(module);
    const authored = parsed?.surfaces.get(className);
    if (parsed === undefined || authored === undefined) return unknownSurface();

    const branch = new Set(stack).add(key);
    let parent = emptySurface();
    if (!authored.inheritanceKnown) parent = unknownSurface();
    else if (authored.superclass !== null && !ELEMENT_ROOTS.has(authored.superclass)) {
      const imported = parsed.imports.get(authored.superclass);
      const parentModule = imported ?? module;
      const parentName = parsed.importNames.get(authored.superclass) ?? authored.superclass;
      parent = resolveClass(parentModule, parentName, branch);
    } else if (authored.superclass !== null) {
      parent = { ...emptySurface(), methods: ROOT_METHODS.get(authored.superclass) ?? new Set() };
    }

    const methods = new Set([...parent.methods, ...authored.methods]);
    if (!reported.has(key)) {
      reported.add(key);
      findings.push(...fieldsHiding(authored.fields, methods, module, className));
    }

    const properties = new Map(parent.properties);
    for (const property of authored.properties) {
      properties.set(property.name, {
        name: property.name,
        kind: property.kind,
        attribute: property.attribute,
        declaration: {
          module,
          className,
          line: property.line,
          column: property.column,
        },
      });
    }

    const events = new Map(parent.events);
    for (const event of authored.events) {
      /** @type {import('./types.js').ElementEvent} */
      const next = {
        name: event.name,
        event: event.event,
        detail: event.detail,
        declaration: {
          module,
          className,
          line: event.line,
          column: event.column,
        },
      };
      const existing = events.get(event.name);
      events.set(event.name, existing === undefined ? next : mergeEvent(existing, next));
    }

    const resolved = {
      properties,
      surfaceKnown: parent.surfaceKnown && authored.propertiesKnown,
      explicitAttributes: authored.attributesDeclared
        ? new Set([
            ...(authored.attributesIncludeSuper ? parent.explicitAttributes : []),
            ...authored.observedAttributes,
          ])
        : new Set(parent.explicitAttributes),
      attributesKnown: authored.attributesDeclared
        ? authored.attributesKnown &&
          (!authored.attributesIncludeSuper || parent.attributesKnown)
        : parent.attributesKnown,
      events,
      eventsKnown: parent.eventsKnown && authored.eventsKnown,
      methods,
    };
    cache.set(key, resolved);
    return resolved;
  };

  for (const record of elements.values()) {
    const surface = resolveClass(record.module, record.className);
    record.propertyDeclarations = [...surface.properties.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    record.properties = record.propertyDeclarations
      .filter((property) => property.kind === 'input')
      .map((property) => property.name);
    record.state = record.propertyDeclarations
      .filter((property) => property.kind === 'state')
      .map((property) => property.name);
    record.surfaceKnown = surface.surfaceKnown;

    const attributes = new Set(surface.explicitAttributes);
    let attributesKnown = surface.attributesKnown;
    for (const property of record.propertyDeclarations) {
      if (typeof property.attribute === 'string') attributes.add(property.attribute);
      else if (property.attribute === null) attributesKnown = false;
    }
    record.observedAttributes = attributesKnown
      ? [...attributes].sort((left, right) => left.localeCompare(right))
      : null;
    record.events = [...surface.events.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    record.eventsKnown = surface.eventsKnown;
  }

  return findings.sort((left, right) => `${left.file}${left.message}`.localeCompare(`${right.file}${right.message}`));
}

/**
 * The fields of one class that cover a method of the same name.
 *
 * A field is installed with [[Define]], so it creates an own property that hides the
 * method instead of overriding it. Nothing complains. The definition is accepted, the
 * element registers, and the first call reaches a string. This is the diagnostic the
 * runtime raises on the first instance, moved to the line that declared the field.
 * ADR-0115.
 *
 * A field whose value no static read can resolve is a warning, never an error. The value may
 * well be a function, and calling a working component broken is how a diagnostic teaches
 * authors to ignore it.
 *
 * @param {import('./parse.mjs').RawField[]} fields
 * @param {Set<string>} methods
 * @param {string} module
 * @param {string} className
 * @returns {ModelFinding[]}
 */
function fieldsHiding(fields, methods, module, className) {
  /** @type {ModelFinding[]} */
  const found = [];
  for (const field of fields) {
    if (field.callable === true || !methods.has(field.name)) continue;
    /** @type {Pick<ModelFinding, 'code' | 'file' | 'line' | 'column'>} */
    const where = {
      code: 'project/shadowed-lifecycle',
      file: module,
      line: field.line,
      column: field.column,
    };
    if (field.callable === null) {
      found.push({
        ...where,
        severity: 'warning',
        message:
          `${className} declares \`${field.name}\` as a field, and it inherits a ` +
          `\`${field.name}()\` method of that name. A field is an own property, so it hides ` +
          'the method rather than overriding it unless its value is a function, and this ' +
          'value is decided somewhere static analysis cannot follow.',
      });
      continue;
    }
    found.push({
      ...where,
      severity: 'error',
      message:
        `${className} declares \`${field.name}\` as a field, which hides the ` +
        `\`${field.name}()\` method it inherits rather than overriding it. A class field is ` +
        'installed as an own property, so every call reaches the field\'s value instead of ' +
        `the method. Write \`${field.name}()\` as a method, or rename the field.`,
    });
  }
  return found;
}

/** @returns {ResolvedSurface} */
function emptySurface() {
  return {
    properties: new Map(),
    surfaceKnown: true,
    explicitAttributes: new Set(),
    attributesKnown: true,
    events: new Map(),
    eventsKnown: true,
    methods: new Set(),
  };
}

/** @returns {ResolvedSurface} */
function unknownSurface() {
  return { ...emptySurface(), surfaceKnown: false, attributesKnown: false, eventsKnown: false };
}

/** Two branches dispatching one name with different shapes remain known by name only. @returns {import('./types.js').ElementEvent} */
function mergeEvent(
  /** @type {import('./types.js').ElementEvent} */ left,
  /** @type {import('./types.js').ElementEvent} */ right,
) {
  if (left.event === right.event && JSON.stringify(left.detail) === JSON.stringify(right.detail)) {
    return left;
  }
  return {
    ...left,
    event: left.event === 'CustomEvent' || right.event === 'CustomEvent' ? 'CustomEvent' : 'Event',
    detail: { kind: /** @type {const} */ ('unknown') },
  };
}

/**
 * Projection buckets are authored by the rendered template, not reconstructed from
 * caller markup. Parse each claimed template once and keep default projection as `''`.
 *
 * @param {Map<string, ElementRecord>} elements
 */
async function readProjectionSlots(elements) {
  for (const record of elements.values()) {
    if (record.template === null) {
      record.slots = [];
      continue;
    }
    if (record.templateExists !== true) {
      record.slots = null;
      continue;
    }
    try {
      const source = await readText(record.template);
      const prepared = source.replace(INTERPOLATION, (expression) => ' '.repeat(expression.length));
      const fragment = /** @type {ProjectionNode} */ (parseFragment(prepared));
      /** @type {Set<string>} */
      const slots = new Set();
      let known = true;
      /** @param {ProjectionNode} node */
      const visit = (node) => {
        if (node.tagName === 'x-content') {
          const name = node.attrs?.find((attribute) => attribute.name === 'name')?.value ?? '';
          if (name.includes('{{')) known = false;
          else slots.add(name);
        }
        for (const child of node.childNodes ?? []) visit(child);
        if (node.content !== undefined) visit(node.content);
      };
      visit(fragment);
      record.slots = known ? [...slots].sort((left, right) => left.localeCompare(right)) : null;
    } catch {
      record.slots = null;
    }
  }
}

/**
 * Each Element's stylesheet, scoped exactly as the browser and the build scope it, so a
 * rule both of them would refuse is reported at the line that wrote it. ADR-0119.
 *
 * @param {Map<string, ElementRecord>} elements
 * @param {ModelFinding[]} findings
 * @param {string[]} roots
 */
async function readStylesheets(elements, findings, roots) {
  /** @type {Map<string, string>} */
  const owners = new Map();
  for (const record of elements.values()) {
    if (record.stylesheet === null) continue;
    const severity = isTestSource(record.module, roots) ? 'warning' : 'error';

    if (record.template === null) {
      findings.push({
        code: 'project/stylesheet-without-template',
        severity,
        file: record.module,
        message:
          `<${record.tag}> declares \`styles: true\` and \`template: false\`. An Element's ` +
          'stylesheet reaches the markup its template renders, and this one renders none.',
      });
      continue;
    }

    const owner = owners.get(record.stylesheet);
    if (owner !== undefined) {
      findings.push({
        code: 'project/shared-stylesheet',
        severity,
        file: record.module,
        message:
          `<${owner}> and <${record.tag}> both declare \`styles: true\` in one module, so both ` +
          'claim its sibling stylesheet. A stylesheet is scoped to one tag; give each Element ' +
          'a module of its own.',
      });
      continue;
    }
    owners.set(record.stylesheet, record.tag);

    if (record.stylesheetExists !== true) continue;
    try {
      scopeStylesheet(record.tag, await readText(record.stylesheet), record.stylesheet);
    } catch (cause) {
      if (!(cause instanceof StylesheetScopeError)) throw cause;
      findings.push({
        code: 'project/stylesheet-scope',
        severity,
        file: record.stylesheet,
        line: cause.line,
        column: cause.column,
        message: `The stylesheet of <${record.tag}> ${cause.reason}`,
      });
    }
  }
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
      // A suite's fixture markup is fetched by a test in the browser, so it stays a
      // real file. Shipping it inside an application's bundle would put test bytes in
      // production.
      fixture: isTestSource(path, roots),
    });
  }
  return templates;
}

/**
 * The import-map prefixes that name source in this repository, as directories.
 *
 * Read from the application's own import map rather than hardcoded, because the map
 * is what the browser resolves against. A prefix added there reaches every static tool
 * with no second edit. Vendored bare specifiers are skipped, because they name files
 * rather than prefixes.
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
    // `resolve` rather than the raw join, because a prefix maps to a directory and a
    // trailing separator would make the same directory two different strings to
    // compare against.
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
 * Stylesheets a definition declares that are not on disk.
 *
 * The browser refuses to define such an Element and the build stops on it, so the
 * verifier names it before either does. An Element with no template is left out,
 * because its stylesheet has nothing to reach and that is the error reported against
 * it instead.
 *
 * @param {ProjectModel} model
 * @returns {ElementRecord[]}
 */
export function missingStylesheets(model) {
  return [...model.elements.values()].filter(
    (record) => record.template !== null && record.stylesheetExists === false,
  );
}

/**
 * Markup beside a component module that no definition claims.
 *
 * Always a leftover from a rename or a deletion, and invisible. The old file keeps
 * being served, keeps passing every check that reads it, and renders nowhere. Only a
 * module-sibling name counts, because an `.html` that is not any module's sibling is a
 * partial or a fixture rather than an abandoned template.
 *
 * @param {ProjectModel} model
 * @returns {TemplateRecord[]}
 */
export function orphanTemplates(model) {
  /** @type {Set<string>} */
  const siblings = new Set();
  for (const path of model.modules.keys()) {
    siblings.add(join(dirname(path), `${basename(path, extname(path))}.html`));
  }
  return [...model.templates.values()].filter(
    (template) => template.claimedBy === null && siblings.has(template.path),
  );
}

/**
 * The templates an application ships, which is everything reachable minus test
 * fixtures.
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
 * The model as JSON, sorted, repository-relative and stable across machines.
 *
 * Stability is what makes it usable. A README table, an editor and an agent all read
 * this, so two runs on two checkouts must produce identical bytes, with no absolute
 * path, no `Map` iteration order and no timestamps.
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
        stylesheet: rel(record.stylesheet),
        uses: record.uses.map((use) => use.tag ?? `${use.className} (unresolved)`).sort(),
        properties: record.properties,
        state: record.state,
        surfaceKnown: record.surfaceKnown,
        propertyDeclarations: record.propertyDeclarations.map((property) => ({
          name: property.name,
          kind: property.kind,
          attribute: property.attribute,
          module: repoPath(property.declaration.module),
          className: property.declaration.className,
          line: property.declaration.line,
          column: property.declaration.column,
        })),
        observedAttributes: record.observedAttributes,
        events: record.events.map((event) => ({
          name: event.name,
          event: event.event,
          detail: event.detail,
          module: repoPath(event.declaration.module),
          className: event.declaration.className,
          line: event.declaration.line,
          column: event.declaration.column,
        })),
        eventsKnown: record.eventsKnown,
        slots: record.slots,
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
        code: diagnostic.code,
        severity: diagnostic.severity,
        file: diagnostic.file,
        line: diagnostic.line,
        column: diagnostic.column,
        message: diagnostic.message.split(REPO + sep).join(''),
      }))
      .sort((left, right) =>
        `${left.file ?? ''}${left.message}`.localeCompare(`${right.file ?? ''}${right.message}`),
      ),
  };
}

/**
 * One element and everything a caller has to know to use it, as text.
 *
 * The question an agent or an editor asks first, which is what `<ui-table>` is, where
 * it is, what can be bound and what its markup needs, answered without reading a
 * 1,300-line module.
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

  if (record.stylesheet !== null) {
    lines.push(
      `  styles    ${show(record.stylesheet)}${record.stylesheetExists === false ? ' — MISSING' : ''}`,
    );
  }

  if (record.properties.length > 0) {
    lines.push(`  inputs     ${record.properties.join(', ')}`);
  }
  if (record.state.length > 0) {
    lines.push(`  state      ${record.state.join(', ')}`);
  }
  if (!record.surfaceKnown) lines.push('  surface    incomplete (dynamic or unresolved declaration)');
  if (record.observedAttributes === null) {
    lines.push('  attributes unknown (the declaration is not statically readable)');
  } else if (record.observedAttributes.length > 0) {
    lines.push(`  attributes ${record.observedAttributes.join(', ')}`);
  }
  if (record.events.length > 0) lines.push(`  events     ${record.events.map((event) => event.name).join(', ')}`);
  if (!record.eventsKnown) lines.push('  events     incomplete (a dispatched name is computed)');
  if (record.slots === null) lines.push('  projection unknown');
  else if (record.slots.length > 0) {
    lines.push(`  projection ${record.slots.map((name) => name === '' ? '(default)' : name).join(', ')}`);
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
 * @returns {Diagnostic[]}
 */
export function projectErrors(model) {
  return model.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
}

/**
 * Test source, meaning a suite or anything inside a `test/` directory of the project
 * it belongs to. Exported for `srl check`, which applies the same rule to one
 * application's warnings.
 *
 * Relative to the root the file was found under, never absolute, and that matters.
 * This repository keeps the model's own fixture projects in `cli/test/fixtures`,
 * so an absolute-path check calls every file in them test source and downgrades every
 * error the fixtures exist to produce. The same trap waits for any checkout under a
 * directory somebody named `test`.
 *
 * @param {string} file
 * @param {readonly string[]} roots
 * @returns {boolean}
 */
export function isTestSource(file, roots) {
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
