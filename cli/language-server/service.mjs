/**
 * Editor-facing language features for srl templates.
 *
 * This module knows editor concepts but no transport. `server.mjs` adapts it to LSP;
 * tests and another editor adapter can call the same values directly. Project facts
 * still come from `project-model/`, template errors still come from
 * `checkTemplateSource()`, and unsaved JavaScript buffers are passed to that checker.
 * ADR-0090.
 */

import { readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

import { checkTemplateSource, parseTemplate } from '../checks/template-check.mjs';
import { REPO, apps } from '../layout.mjs';
import { readMessages, referenceFindings, sourceReferences } from '../message-catalog/index.mjs';
import { readProject } from '../project-model/index.mjs';
import { AuthoredTemplates } from './authoring.mjs';

/** @import { Diagnostic } from '../diagnostics/types.js' */
/** @import { ElementRecord, ProjectModel } from '../project-model/types.js' */
/** @import { MessageModel } from '../message-catalog/types.js' */

/** @typedef {{ kind: 'text', value: string, at: number } | { kind: 'element', tag: string, attributes: Array<{ name: string, value: string, at: number }>, children: TemplateNode[], at: number }} TemplateNode */
/** @typedef {{ line: number, character: number }} Position */
/** @typedef {{ start: Position, end: Position }} Range */
/** @typedef {{ name: string, detail: string, kind: number, range: Range, selectionRange: Range, children: LspDocumentSymbol[] }} LspDocumentSymbol */
/** @typedef {{ name: string, kind: number, detail: string, documentation: string, location: { uri: string, range: Range } }} ClassSymbol */

/**
 * One long-lived language service per repository root.
 */
export class SrlLanguageService {
  /** @type {Map<string, { languageId: string, version: number, text: string }>} */
  documents = new Map();
  /** @type {ProjectModel[]} */
  models = [];
  /**
   * One per application, in the same order as `models`. The catalogs are the files as
   * saved: a bundle is not what is being edited in a buffer.
   *
   * @type {MessageModel[]}
   */
  messages = [];
  /** Which authoring form each document is in, and what may be asked of it. ADR-0090. */
  #authoring = new AuthoredTemplates({ documents: this.documents });

  /** Rebuild project models after source, declarations, or import maps change. */
  async reload() {
    const discovered = await apps();
    const models = [];
    /** @type {MessageModel[]} */
    const messages = [];
    for (const app of discovered) {
      const model = await readProject(app);
      models.push(model);
      messages.push(await readMessages(app, model));
    }
    this.models = models;
    this.messages = messages;
  }

  /** @param {string} uri @param {string} languageId @param {number} version @param {string} text */
  open(uri, languageId, version, text) {
    this.documents.set(uri, { languageId, version, text });
  }

  /** @param {string} uri @param {number} version @param {string} text */
  change(uri, version, text) {
    const current = this.documents.get(uri);
    this.documents.set(uri, { languageId: current?.languageId ?? languageId(uri), version, text });
  }

  /** @param {string} uri */
  close(uri) {
    this.documents.delete(uri);
  }

  /** @param {string} uri @returns {number | undefined} The version of an open document. */
  version(uri) {
    return this.documents.get(uri)?.version;
  }

  /**
   * Which open documents a change to `path` can change the answer for.
   *
   * A template is checked through a shim that imports the component's own module, the
   * module of every custom element the template names, and the module of every global it
   * may use. An unsaved edit to any of those changes that template's diagnostics while
   * the template's own text stands still, so the dependency is the shim's import list
   * rather than the file the editor happened to change.
   *
   * Only open documents are answered. A closed file's diagnostics are not on screen, and
   * revalidating every template in the repository on each keystroke is the cost this
   * question exists to avoid.
   *
   * The shim's own imports are followed, not theirs. An unsaved edit to a module that
   * only an element's module imports is seen on save, when the model reloads and every
   * open document is stale again; following it live would mean an import graph whose
   * only consumer is a keystroke.
   *
   * @param {string} path
   * @returns {string[]} document URIs to revalidate
   */
  dependents(path) {
    /** @type {Set<string>} */
    const affected = new Set();
    const own = toUri(path);
    if (this.documents.has(own)) affected.add(own);
    if (!/\.m?js$/u.test(path)) return [...affected];

    for (const [uri, document] of this.documents) {
      const template = fromUri(uri);
      if (this.#authoring.form(template) !== 'srl') continue;
      const model = this.model(uri);
      if (model === undefined) continue;
      const component = this.component(model, template);
      if (component === undefined) continue;
      if (component.module === path) {
        affected.add(uri);
        continue;
      }
      if ([...model.globals.values()].some((global) => global.module === path)) {
        affected.add(uri);
        continue;
      }
      // Unparseable markup is exactly when the tag list is unknown, so it is assumed to
      // depend on the change rather than assumed not to.
      let tags;
      try {
        tags = templateTags(parseTemplate(document.text, template));
      } catch {
        affected.add(uri);
        continue;
      }
      for (const tag of tags) {
        if (model.elements.get(tag)?.module === path) {
          affected.add(uri);
          break;
        }
      }
    }
    return [...affected];
  }

  /** @param {string} uri @returns {Promise<string>} */
  async source(uri) {
    return this.documents.get(uri)?.text ?? readFile(fromUri(uri), 'utf8');
  }

  /** @param {string} uri @returns {ProjectModel | undefined} */
  model(uri) {
    const path = fromUri(uri);
    return (
      this.models.find((model) => model.templates.has(path)) ??
      this.models.find((model) => inside(path, model.app.dir)) ??
      this.models.find((model) =>
        [...model.elements.values()].some(
          (element) => element.module === path || element.template === path,
        ),
      ) ??
      this.models[0]
    );
  }

  /**
   * The component a document belongs to. For a template that is the component whose
   * template it is, and for a JavaScript module it is the component the module
   * declares, which is where its inline Lit markup, its `uses` list and its property
   * surface all live.
   *
   * @param {ProjectModel} model @param {string} path @returns {ElementRecord | undefined}
   */
  component(model, path) {
    const claim = model.templates.get(path)?.claimedBy;
    if (claim !== undefined && claim !== null) return model.elements.get(claim);
    const elements = [...model.elements.values()];
    return (
      elements.find((element) => element.template === path) ??
      elements.find((element) => element.module === path)
    );
  }

  /**
   * Inline template and project-model diagnostics for one editor document.
   *
   * @param {string} uri
   * @param {{ cancellation?: import('typescript').CancellationToken }} [options]
   *   `cancellation` abandons the typecheck when its answer stops being worth the thread.
   *   It throws `ts.OperationCanceledException` out of this call rather than returning a
   *   partial answer, because a short diagnostic list reads as "no errors here".
   */
  async diagnostics(uri, options = {}) {
    const path = fromUri(uri);
    const model = this.model(uri);
    if (model === undefined) return [];
    const source = await this.source(uri);
    /** @type {Diagnostic[]} */
    const found = [];

    // A diagnostic spells its file relative to the repository, and `path` is absolute.
    for (const project of this.models) {
      found.push(
        ...project.diagnostics.filter(
          (diagnostic) => diagnostic.file !== null && resolve(REPO, diagnostic.file) === path,
        ),
      );
    }

    // The keys this buffer names, resolved against the bundles as saved. A misspelled key
    // is a raw key in the page, and the editor is where it is cheapest to see.
    const catalog = this.messages.find((message) => message.app.dir === model.app.dir);
    if (catalog !== undefined) {
      found.push(...referenceFindings(catalog, await sourceReferences(model, path, source)));
    }

    const form = this.#authoring.form(path);
    const component = this.component(model, path);

    if (form === 'srl') {
      if (component !== undefined) {
        try {
          found.push(
            ...checkTemplateSource({
              module: component.module,
              className: component.className,
              template: path,
              source,
              elements: checkerElements(model),
              globals: model.globals,
              available: new Set(component.usesTags),
              files: this.openJavaScript(),
              cancellation: options.cancellation,
            }),
          );
        } catch (cause) {
          // A cancelled check has no findings, not zero findings. It is the caller's to
          // retry, so it travels rather than being reported as a template error.
          if (cause instanceof ts.OperationCanceledException) throw cause;
          found.push({
            severity: 'error',
            code: 'templates/syntax',
            message: cause instanceof Error ? cause.message : String(cause),
            group: model.app.name,
            file: path,
            line: 1,
            column: 1,
          });
        }
      }
    }

    if (form === 'lit' && component !== undefined) {
      const view = this.#view(uri, source, model, component);
      for (const unavailable of view.unavailableTags(model, component)) {
        found.push({
          severity: 'error',
          code: 'templates/missing-use',
          message: unavailableMessage(path, unavailable),
          group: model.app.name,
          file: path,
          ...oneBased(positionAt(source, unavailable.at)),
        });
      }
    }

    return uniqueDiagnostics(found).map((diagnostic) => lspDiagnostic(diagnostic, source));
  }

  /** @returns {Map<string, string>} */
  openJavaScript() {
    return new Map(
      [...this.documents.entries()]
        .filter(([uri]) => /\.m?js$/u.test(fromUri(uri)))
        .map(([uri, document]) => [fromUri(uri), document.text]),
    );
  }

  /** @param {string} uri @param {Position} position Completions for tags, bindings, directives, events, and template names. */
  async completion(uri, position) {
    const source = await this.source(uri);
    const offset = offsetAt(source, position);
    const model = this.model(uri);
    if (model === undefined) return [];
    const component = this.component(model, fromUri(uri));
    const view = this.#view(uri, source, model, component);
    const context = view.at(offset);

    if (context.kind === 'tag' && context.typed) return tagCompletions(model, component);
    if (context.kind === 'expression') {
      const members = view.membersAt(offset);
      if (members !== undefined) return members;
      const symbols =
        component === undefined
          ? []
          : await classSymbols(component.module, component.className, this.documents);
      return expressionCompletions(symbols, model, context.locals);
    }
    if (context.kind === 'attribute-value' && context.name === 'slot') {
      return projectionCompletions(model.elements.get(context.parentTag ?? ''));
    }
    if (context.kind === 'opening-tag' || context.kind === 'attribute') {
      return view.attributeCompletions(context.tag, model.elements.get(context.tag));
    }
    return [];
  }

  /** @param {string} uri @param {Position} position Hover over custom tags, public bindings, directives, and host members. */
  async hover(uri, position) {
    const source = await this.source(uri);
    const offset = offsetAt(source, position);
    const model = this.model(uri);
    if (model === undefined) return null;
    const component = this.component(model, fromUri(uri));
    const view = this.#view(uri, source, model, component);
    const tag = view.tagAt(offset);
    if (tag !== undefined) {
      const record = model.elements.get(tag.name);
      if (record !== undefined) return elementHover(record);
    }

    const context = view.at(offset);
    if (context.kind === 'attribute') {
      const record = model.elements.get(context.tag);
      const hover = view.attributeHover(context.name, record);
      if (hover !== null) return { contents: { kind: 'markdown', value: hover } };
    }

    if (context.kind === 'attribute-value' && context.name === 'slot') {
      const parent = model.elements.get(context.parentTag ?? '');
      if (parent?.slots !== undefined && parent.slots !== null) {
        const names = parent.slots.filter((name) => name !== '');
        const text = names.length === 0 ? 'default projection' : `projection: ${names.join(', ')}`;
        return { contents: { kind: 'markdown', value: `**\`slot\`** — ${text} of \`<${parent.tag}>\`.` } };
      }
    }

    if (context.kind !== 'expression' || component === undefined) return null;
    const word = wordAt(source, offset);
    if (word === undefined) return null;
    const symbols = await classSymbols(component.module, component.className, this.documents);
    const symbol = symbols.find((candidate) => candidate.name === word.text);
    const global = model.globals.get(word.text);
    if (symbol === undefined && global === undefined) return null;
    const value =
      symbol === undefined
        ? `**${word.text}** — template global\n\n${relativePath(global?.module ?? '')}`
        : `\`\`\`js\n${symbol.detail}\n\`\`\`${symbol.documentation === '' ? '' : `\n\n${symbol.documentation}`}`;
    return { contents: { kind: 'markdown', value }, range: rangeAt(source, word.start, word.end) };
  }

  /** @param {string} uri @param {Position} position Definitions for custom tags, custom-element bindings, and host members. */
  async definition(uri, position) {
    const source = await this.source(uri);
    const offset = offsetAt(source, position);
    const model = this.model(uri);
    if (model === undefined) return [];
    const component = this.component(model, fromUri(uri));
    const view = this.#view(uri, source, model, component);
    const tag = view.tagAt(offset);
    if (tag !== undefined) {
      const record = model.elements.get(tag.name);
      if (record !== undefined) return [await elementLocation(record, this.documents)];
    }

    const context = view.at(offset);
    if (context.kind === 'attribute') {
      const record = model.elements.get(context.tag);
      const name = view.boundProperty(context.name);
      if (record !== undefined && name !== null && record.properties.includes(name)) {
        const property = record.propertyDeclarations.find((candidate) => candidate.name === name);
        if (property !== undefined) return [declarationLocation(property.declaration, name)];
      }
    }

    const word = wordAt(source, offset);
    if (context.kind !== 'expression' || component === undefined || word === undefined) return [];
    const symbols = await classSymbols(component.module, component.className, this.documents);
    const symbol = symbols.find((candidate) => candidate.name === word.text);
    if (symbol !== undefined) return [symbol.location];
    const global = model.globals.get(word.text);
    return global === undefined ? [] : [await moduleLocation(global.module, global.exportName, this.documents)];
  }

  /**
   * Every place a tag is named as a tag, in both authoring forms this project supports.
   *
   * An external srl template is read through the shared semantic snapshot, so a name
   * written in a comment or inside `<script>` text is not a use. A handwritten Lit
   * component writes its markup in `html` templates in JavaScript instead. A scan
   * that visited template files alone would report no uses for markup that is really
   * there, which makes rename edit half a project and call it done.
   *
   * A file whose text never contains the name cannot contain a span of it, so it is
   * skipped before it is parsed. Callers receive the text each span was measured in,
   * because a range is only meaningful against it.
   *
   * @param {string} name
   * @returns {Promise<Array<{ uri: string, text: string, spans: Array<{ start: number, end: number }> }>>}
   */
  async #tagUses(name) {
    /** @type {Array<{ uri: string, text: string, spans: Array<{ start: number, end: number }> }>} */
    const uses = [];
    const seen = new Set();
    for (const project of this.models) {
      for (const path of [...project.templates.keys(), ...project.modules.keys()]) {
        if (seen.has(path)) continue;
        seen.add(path);
        const uri = toUri(path);
        const text = await this.source(uri);
        if (!text.includes(name)) continue;
        const owner = this.component(project, path);
        const spans = this.#view(uri, text, project, owner).tags(name);
        if (spans.length > 0) uses.push({ uri, text, spans });
      }
    }
    return uses;
  }

  /** @param {string} uri @param {Position} position @param {boolean} includeDeclaration Every use of a custom-element tag in templates, optionally including its declaration. */
  async references(uri, position, includeDeclaration) {
    const source = await this.source(uri);
    const model = this.model(uri);
    if (model === undefined) return [];
    const tag = await this.#tagIdentityAt(uri, source, position, model);
    if (tag === undefined || !model.elements.has(tag.name)) return [];
    const locations = [];
    for (const use of await this.#tagUses(tag.name)) {
      for (const span of use.spans) {
        locations.push({ uri: use.uri, range: rangeAt(use.text, span.start, span.end) });
      }
    }
    if (includeDeclaration) {
      const record = model.elements.get(tag.name);
      if (record !== undefined) locations.push(await elementLocation(record, this.documents));
    }
    return locations;
  }

  /** @param {string} uri @param {Position} position Only tag identity is safely renameable across JavaScript and markup. */
  async prepareRename(uri, position) {
    const source = await this.source(uri);
    const model = this.model(uri);
    if (model === undefined) return null;
    const tag = await this.#tagIdentityAt(uri, source, position, model);
    if (tag === undefined || model.elements.has(tag.name) !== true) return null;
    return { range: rangeAt(source, tag.start, tag.end), placeholder: tag.name };
  }

  /** @param {string} uri @param {{ line: number, character: number }} position @param {string} newName */
  async rename(uri, position, newName) {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/u.test(newName)) {
      throw new Error('An srl custom-element tag must contain a hyphen and use lowercase ASCII.');
    }
    const source = await this.source(uri);
    const model = this.model(uri);
    if (model === undefined) return null;
    const tag = await this.#tagIdentityAt(uri, source, position, model);
    if (tag === undefined) return null;
    const record = model.elements.get(tag.name);
    if (record === undefined) return null;
    const existing = model.elements.get(newName);
    if (existing !== undefined && existing.tag !== record.tag) {
      throw new Error(`<${newName}> is already registered by ${existing.className}.`);
    }

    /** @type {Record<string, Array<{ range: Range, newText: string }>>} */
    const changes = {};
    for (const use of await this.#tagUses(tag.name)) {
      changes[use.uri] = use.spans.map((span) => ({
        range: rangeAt(use.text, span.start, span.end),
        newText: newName,
      }));
    }
    const declaration = await tagDeclaration(record, this.documents);
    if (declaration !== null) {
      const edits = changes[declaration.uri] ?? [];
      edits.push({ range: declaration.range, newText: newName });
      changes[declaration.uri] = edits;
    }
    return { changes };
  }

  /** @param {string} uri Semantic tokens supplement native HTML highlighting with srl grammar. */
  async semanticTokens(uri) {
    const source = await this.source(uri);
    const model = this.model(uri);
    if (model === undefined) return { data: [] };
    const component = this.component(model, fromUri(uri));
    const view = this.#view(uri, source, model, component);
    return { data: encodeSemanticTokens(source, view.highlights()) };
  }

  /** @param {string} uri Custom tag names link to their declaring JavaScript modules. */
  async documentLinks(uri) {
    const source = await this.source(uri);
    const model = this.model(uri);
    if (model === undefined) return [];
    const component = this.component(model, fromUri(uri));
    const view = this.#view(uri, source, model, component);
    const links = [];
    for (const [tag, record] of model.elements) {
      for (const span of view.tags(tag)) {
        links.push({
          range: rangeAt(source, span.start, span.end),
          target: toUri(record.module),
          tooltip: `${record.className} in ${relativePath(record.module)}`,
        });
      }
    }
    return links;
  }

  /** @param {string} uri Template outline preserving element nesting. */
  async documentSymbols(uri) {
    const source = await this.source(uri);
    const model = this.model(uri);
    if (model === undefined) return [];
    const component = this.component(model, fromUri(uri));
    const roots = this.#view(uri, source, model, component).roots;
    const symbols = [];
    for (const node of roots) {
      if (node.kind === 'element') symbols.push(elementSymbol(source, node));
    }
    return symbols;
  }

  /** @param {string} query Search custom elements from editor-wide symbol navigation. */
  async workspaceSymbols(query) {
    const needle = query.toLowerCase();
    const symbols = [];
    const seen = new Set();
    for (const model of this.models) {
      for (const record of model.elements.values()) {
        if (seen.has(record.tag) || !record.tag.includes(needle)) continue;
        seen.add(record.tag);
        symbols.push({
          name: `<${record.tag}>`,
          kind: 5,
          location: await elementLocation(record, this.documents),
          containerName: record.className,
        });
      }
    }
    return symbols;
  }

  /** @param {string} uri @param {Range} range @param {Array<{ code?: string | number, message: string }>} diagnostics Quick fix for a known element omitted from a component's `uses` list. */
  async codeActions(uri, range, diagnostics) {
    const source = await this.source(uri);
    const model = this.model(uri);
    const owner = model === undefined ? undefined : this.component(model, fromUri(uri));
    if (model === undefined || owner === undefined) return [];
    const actions = [];
    for (const diagnostic of diagnostics) {
      if (diagnostic.code !== 'templates/missing-use') continue;
      const start = offsetAt(source, range.start);
      const view = this.#view(uri, source, model, owner);
      const tag = view.tagAt(start) ?? view.tagAt(Math.min(source.length, start + 1));
      const target = tag === undefined ? undefined : model.elements.get(tag.name);
      if (target === undefined || !target.exported) continue;
      const edit = await view.addUse(target);
      if (edit === null) continue;
      actions.push({
        title: `Add ${target.className} to ${owner.className}.uses`,
        kind: 'quickfix',
        diagnostics: [diagnostic],
        edit,
        isPreferred: true,
      });
    }
    return actions;
  }

  /** @param {string} uri @param {string} source @param {ProjectModel} model @param {ElementRecord | undefined} component */
  #view(uri, source, model, component) {
    return this.#authoring.view({ path: fromUri(uri), source, model, component });
  }

  /**
   * Resolve custom-element identity from a tag written in either authored form, or from
   * its JavaScript registration literal. The last lets rename start at the declaration
   * while retaining one project-wide tag operation. ADR-0090, ADR-0090.
   *
   * @param {string} uri
   * @param {string} source
   * @param {Position} position
   * @param {ProjectModel} model
   */
  async #tagIdentityAt(uri, source, position, model) {
    const offset = offsetAt(source, position);
    const path = fromUri(uri);
    const view = this.#view(uri, source, model, this.component(model, path));
    if (view.form === 'srl') return view.tagAt(offset);

    for (const record of model.elements.values()) {
      if (record.module !== path) continue;
      const declaration = await tagDeclaration(record, this.documents);
      if (declaration === null) continue;
      const start = offsetAt(source, declaration.range.start);
      const end = offsetAt(source, declaration.range.end);
      if (start <= offset && offset <= end) return { name: record.tag, start, end };
    }

    // A handwritten Lit component names other elements in its own markup templates, and
    // the tag under the cursor there is the same identity as one written in a template
    // file, not a string the caller happens to be editing.
    const inline = view.tagAt(offset);
    return inline !== undefined && model.elements.has(inline.name) ? inline : undefined;
  }
}

/** @param {ProjectModel} model */
function checkerElements(model) {
  return new Map(
    [...model.elements].map(([tag, record]) => [
      tag,
      {
        module: record.module,
        className: record.className,
        exported: record.exported,
        properties: record.properties,
        state: record.state,
        observedAttributes: record.observedAttributes,
        events: record.events,
      },
    ]),
  );
}

/** @param {ProjectModel} model @param {ElementRecord | undefined} component */
function tagCompletions(model, component) {
  const available = new Set(component?.usesTags ?? []);
  return [...model.elements.values()]
    .filter((record) => !relativePath(record.module).split('/').includes('test'))
    .sort((left, right) => Number(available.has(right.tag)) - Number(available.has(left.tag)) || left.tag.localeCompare(right.tag))
    .map((record) => ({
      label: `<${record.tag}>`,
      filterText: record.tag,
      kind: 7,
      detail: `${record.className}${available.has(record.tag) ? '' : ' — add to uses'}`,
      documentation: elementMarkdown(record),
      insertText: `${record.tag}>$0</${record.tag}>`,
      insertTextFormat: 2,
      sortText: `${available.has(record.tag) ? '0' : '1'}-${record.tag}`,
    }));
}

/** Named projection buckets accepted by the parent element.
 * @param {ElementRecord | undefined} record @returns {Array<Record<string, unknown>>}
 */
function projectionCompletions(record) {
  if (record?.slots === undefined || record.slots === null) return [];
  return record.slots
    .filter((name) => name !== '')
    .map((name) => ({
      label: name,
      kind: 12,
      detail: `${record.className} projection`,
      insertText: name,
    }));
}

/** @param {Awaited<ReturnType<typeof classSymbols>>} symbols @param {ProjectModel} model @param {string[]} locals */
function expressionCompletions(symbols, model, locals) {
  /** @type {Array<Record<string, unknown>>} */
  const found = symbols.map((symbol) => ({
    label: symbol.name,
    kind: symbol.kind,
    detail: symbol.detail,
    documentation: symbol.documentation,
  }));
  for (const [name, global] of model.globals) {
    found.push({
      label: name,
      kind: 3,
      detail: `template global from ${relativePath(global.module)}`,
    });
  }
  for (const local of locals) {
    found.push({ label: local, kind: 6, detail: 'template loop local' });
  }
  return uniqueBy(found, (item) => String(item.label));
}

/** @param {ElementRecord} record */
function elementHover(record) {
  return { contents: { kind: 'markdown', value: elementMarkdown(record) } };
}

/** @param {ElementRecord} record */
function elementMarkdown(record) {
  const lines = [
    `**\`<${record.tag}>\` — \`${record.className}\`**`,
    '',
    `Defined in \`${relativePath(record.module)}\`.`,
  ];
  if (record.properties.length > 0) lines.push('', `Properties: ${record.properties.map((name) => `\`${name}\``).join(', ')}`);
  if (record.observedAttributes !== null && record.observedAttributes.length > 0) {
    lines.push('', `Attributes: ${record.observedAttributes.map((name) => `\`${name}\``).join(', ')}`);
  }
  if (record.events.length > 0) {
    lines.push('', `Events: ${record.events.map((event) => `\`${event.name}\``).join(', ')}`);
  }
  if (record.slots !== null && record.slots.length > 0) {
    lines.push(
      '',
      `Projection: ${record.slots.map((name) => name === '' ? '`default`' : `\`${name}\``).join(', ')}`,
    );
  }
  return lines.join('\n');
}

/** @param {ElementRecord} record @param {Map<string, { text: string }>} documents @returns {Promise<{ uri: string, range: Range }>} */
async function elementLocation(record, documents) {
  return (await tagDeclaration(record, documents)) ?? moduleLocation(record.module, record.className, documents);
}

/** @param {ElementRecord} record @param {Map<string, { text: string }>} documents @returns {Promise<{ uri: string, range: Range } | null>} */
async function tagDeclaration(record, documents) {
  const uri = toUri(record.module);
  const source = documents.get(uri)?.text ?? (await readFile(record.module, 'utf8'));
  const tree = ts.createSourceFile(record.module, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const object = definitionObject(tree, record.className);
  const property = object?.properties.find(
    (candidate) => ts.isPropertyAssignment(candidate) && nodeName(candidate.name) === 'tag',
  );
  if (
    property !== undefined &&
    ts.isPropertyAssignment(property) &&
    ts.isStringLiteralLike(property.initializer)
  ) {
    return location(property.initializer);
  }

  /** @type {ts.StringLiteralLike | undefined} */
  let found;
  /** @param {ts.Node} node */
  const visit = (node) => {
    if (found !== undefined) return;
    if (ts.isCallExpression(node) && calledName(node.expression) === 'customElements.define') {
      const tag = node.arguments[0];
      const element = node.arguments[1];
      if (
        tag !== undefined &&
        ts.isStringLiteralLike(tag) &&
        tag.text.toLowerCase() === record.tag &&
        element !== undefined &&
        ts.isIdentifier(element) &&
        element.text === record.className
      ) found = tag;
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found === undefined ? null : location(found);

  /** @param {ts.StringLiteralLike} literal */
  function location(literal) {
    const start = literal.getStart(tree) + 1;
    return { uri, range: rangeAt(source, start, start + literal.text.length) };
  }
}

/** @param {string} module @param {string} name @param {Map<string, { text: string }>} documents @returns {Promise<{ uri: string, range: Range }>} */
async function moduleLocation(module, name, documents) {
  const symbols = await classSymbols(module, name, documents);
  const own = symbols.find((symbol) => symbol.name === name);
  if (own !== undefined) return own.location;
  const uri = toUri(module);
  return { uri, range: rangeAt(documents.get(uri)?.text ?? '', 0, 0) };
}

/** @param {import('../project-model/types.js').ElementDeclaration} declaration @param {string} name */
function declarationLocation(declaration, name) {
  const start = { line: declaration.line - 1, character: declaration.column - 1 };
  return {
    uri: toUri(declaration.module),
    range: {
      start,
      end: { line: start.line, character: start.character + name.length },
    },
  };
}

/**
 * Public class members as completion, hover, and navigation values.
 *
 * @param {string} module
 * @param {string} className
 * @param {Map<string, { text: string }>} documents
 * @returns {Promise<ClassSymbol[]>}
 */
async function classSymbols(module, className, documents) {
  const uri = toUri(module);
  const source = documents.get(uri)?.text ?? (await readFile(module, 'utf8'));
  const tree = ts.createSourceFile(module, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  /** @type {ClassSymbol[]} */
  const symbols = [];
  for (const statement of tree.statements) {
    if (!ts.isClassDeclaration(statement) || statement.name?.text !== className) continue;
    symbols.push(symbolFromNode(statement.name, 7, statement.getText(tree).split('{')[0]?.trim() ?? `class ${className}`, statement));
    for (const member of statement.members) {
      if (hasModifier(member, ts.SyntaxKind.StaticKeyword) || hasModifier(member, ts.SyntaxKind.PrivateKeyword)) continue;
      const name = nodeName(member.name);
      if (name === undefined || member.name === undefined || name === 'constructor') continue;
      const kind = ts.isMethodDeclaration(member) ? 2 : 10;
      const text = member.getText(tree);
      const detail = ts.isMethodDeclaration(member)
        ? text.slice(0, Math.max(text.indexOf('{'), text.indexOf(';'))).trim()
        : text.split('\n')[0]?.trim() ?? name;
      symbols.push(symbolFromNode(member.name, kind, detail, member));
    }
  }
  return uniqueBy(symbols, (symbol) => symbol.name);

  /** @param {ts.Node} nameNode @param {number} kind @param {string} detail @param {ts.Node} documented @returns {ClassSymbol} */
  function symbolFromNode(nameNode, kind, detail, documented) {
    const start = nameNode.getStart(tree);
    return {
      name: nodeName(nameNode) ?? className,
      kind,
      detail,
      documentation: documentationFor(source, documented),
      location: { uri, range: rangeAt(source, start, nameNode.end) },
    };
  }
}

/** @param {string} source @param {ts.Node} node */
function documentationFor(source, node) {
  const ranges = ts.getLeadingCommentRanges(source, node.getFullStart()) ?? [];
  const comment = ranges.at(-1);
  if (comment === undefined || comment.end < node.getStart() - 2) return '';
  return source
    .slice(comment.pos, comment.end)
    .replace(/^\/\*\*?/u, '')
    .replace(/\*\/$/u, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\* ?/u, ''))
    .filter((line) => !line.trimStart().startsWith('@'))
    .join('\n')
    .trim();
}

/** @param {string} source @param {number} offset */
function wordAt(source, offset) {
  let start = offset;
  let end = offset;
  while (start > 0 && /[A-Za-z0-9_$]/u.test(source[start - 1] ?? '')) start -= 1;
  while (end < source.length && /[A-Za-z0-9_$]/u.test(source[end] ?? '')) end += 1;
  return start === end ? undefined : { text: source.slice(start, end), start, end };
}

/** @param {string} source @param {Array<{ start: number, length: number, type: number }>} spans */
function encodeSemanticTokens(source, spans) {
  const data = [];
  let previousLine = 0;
  let previousCharacter = 0;
  for (const span of spans) {
    const position = positionAt(source, span.start);
    const deltaLine = position.line - previousLine;
    const deltaCharacter = deltaLine === 0 ? position.character - previousCharacter : position.character;
    data.push(deltaLine, deltaCharacter, span.length, span.type, 0);
    previousLine = position.line;
    previousCharacter = position.character;
  }
  return data;
}

/** @param {string} source @param {Extract<TemplateNode, { kind: 'element' }>} node @returns {LspDocumentSymbol} */
function elementSymbol(source, node) {
  const nameStart = node.at + 1;
  const openEnd = source.indexOf('>', node.at);
  const end = openEnd === -1 ? nameStart + node.tag.length : openEnd + 1;
  return {
    name: `<${node.tag}>`,
    detail: node.attributes.map((attribute) => attribute.name).join(' '),
    kind: 19,
    range: rangeAt(source, node.at, end),
    selectionRange: rangeAt(source, nameStart, nameStart + node.tag.length),
    children: node.children
      .filter((child) => child.kind === 'element')
      .map((child) => elementSymbol(source, child)),
  };
}

/** @param {ts.SourceFile} tree @param {string} className */
function definitionObject(tree, className) {
  /** @type {ts.ObjectLiteralExpression | undefined} */
  let found;
  /** @param {ts.Node} node */
  const visit = (node) => {
    if (found !== undefined) return;
    if (ts.isCallExpression(node) && calledName(node.expression) === 'defineComponent') {
      const object = node.arguments[0];
      if (object !== undefined && ts.isObjectLiteralExpression(object)) {
        const element = object.properties.find(
          (property) => ts.isPropertyAssignment(property) && nodeName(property.name) === 'element',
        );
        if (
          element !== undefined &&
          ts.isPropertyAssignment(element) &&
          ts.isIdentifier(element.initializer) &&
          element.initializer.text === className
        ) found = object;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

/** @param {string} source @param {number} start @param {number} end */
function rangeAt(source, start, end) {
  return { start: positionAt(source, start), end: positionAt(source, end) };
}

/** @param {string} source @param {{ line: number, character: number }} position */
function offsetAt(source, position) {
  let line = 0;
  let offset = 0;
  while (line < position.line && offset < source.length) {
    const next = source.indexOf('\n', offset);
    if (next === -1) return source.length;
    offset = next + 1;
    line += 1;
  }
  return Math.min(source.length, offset + position.character);
}

/**
 * Why a tag written in inline Lit markup will not render, in the checker's own words and
 * under its code, so one quick fix answers both authored forms.
 *
 * @param {string} path @param {import('./authoring.mjs').UnavailableTag} unavailable
 */
function unavailableMessage(path, unavailable) {
  const { record } = unavailable;
  return (
    `${relativePath(path)}: <${unavailable.tag}> is ${record.className} in ` +
    `${relativePath(record.module)}, which this component does not import. ` +
    `Add \`${record.className}\` to its \`uses\`.`
  );
}

/** @param {Position} position Diagnostics count lines and columns from one. */
function oneBased(position) {
  return { line: position.line + 1, column: position.character + 1 };
}

/** @param {string} source @param {number} offset */
function positionAt(source, offset) {
  const before = source.slice(0, Math.max(0, offset));
  const line = before.split('\n').length - 1;
  const last = before.lastIndexOf('\n');
  return { line, character: before.length - last - 1 };
}

/** @param {Diagnostic} diagnostic @param {string} source */
function lspDiagnostic(diagnostic, source) {
  const line = diagnostic.line === null ? 0 : Math.max(0, diagnostic.line - 1);
  const character = diagnostic.column === null ? 0 : Math.max(0, diagnostic.column - 1);
  const lineText = source.split('\n')[line] ?? '';
  let end = character;
  while (end < lineText.length && /[^\s"'<>={}]/u.test(lineText[end] ?? '')) end += 1;
  if (end === character) end = Math.min(lineText.length, character + 1);
  const severity = diagnostic.severity === 'error' ? 1 : diagnostic.severity === 'warning' ? 2 : 3;
  return {
    range: { start: { line, character }, end: { line, character: end } },
    severity,
    code: diagnostic.code,
    source: 'srl',
    message: diagnostic.message,
  };
}

/** @param {Diagnostic[]} diagnostics @returns {Diagnostic[]} */
function uniqueDiagnostics(diagnostics) {
  return uniqueBy(diagnostics, (diagnostic) =>
    [diagnostic.code, diagnostic.message, diagnostic.line ?? '', diagnostic.column ?? ''].join('\0'),
  );
}

/** @template T @param {T[]} values @param {(value: T) => string} key @returns {T[]} */
function uniqueBy(values, key) {
  /** @type {Map<string, T>} */
  const found = new Map();
  for (const value of values) if (!found.has(key(value))) found.set(key(value), value);
  return [...found.values()];
}

/** @param {ts.Node | undefined} node */
function nodeName(node) {
  return node !== undefined && (ts.isIdentifier(node) || ts.isStringLiteralLike(node))
    ? node.text
    : undefined;
}

/** @param {ts.Node} node @param {ts.SyntaxKind} kind */
function hasModifier(node, kind) {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false);
}

/** @param {ts.Expression} expression @returns {string | undefined} */
function calledName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    /** @type {string | undefined} */
    const left = calledName(expression.expression);
    return left === undefined ? expression.name.text : `${left}.${expression.name.text}`;
  }
  return undefined;
}

/** @param {TemplateNode[]} nodes @returns {Set<string>} Every tag the markup names. */
function templateTags(nodes) {
  /** @type {Set<string>} */
  const tags = new Set();
  /** @param {TemplateNode[]} level */
  const walk = (level) => {
    for (const node of level) {
      if (node.kind !== 'element') continue;
      tags.add(node.tag);
      walk(node.children);
    }
  };
  walk(nodes);
  return tags;
}

/** @param {string} parent @param {string} directory */
function inside(parent, directory) {
  const path = relative(directory, parent);
  return path === '' || (!path.startsWith('..') && !path.startsWith(sep));
}

/** @param {string} uri */
function fromUri(uri) {
  return fileURLToPath(uri);
}

/** @param {string} path */
function toUri(path) {
  return pathToFileURL(path).href;
}

/** @param {string} uri */
function languageId(uri) {
  if (uri.endsWith('.html')) return 'html';
  if (/\.m?js$/u.test(uri)) return 'javascript';
  return 'plaintext';
}

/** @param {string} path */
function relativePath(path) {
  const cwd = process.cwd();
  const shown = relative(cwd, path).split(sep).join('/');
  return shown.startsWith('..') ? path : shown;
}
