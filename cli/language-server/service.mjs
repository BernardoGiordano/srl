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
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

import { checkTemplateSource, parseTemplate } from '../checks/template-check.mjs';
import { apps } from '../layout.mjs';
import { readProject } from '../project-model/index.mjs';

/** @import { Diagnostic } from '../diagnostics/types.js' */
/** @import { ElementRecord, ProjectModel } from '../project-model/types.js' */

/** @typedef {{ kind: 'text', value: string, at: number } | { kind: 'element', tag: string, attributes: Array<{ name: string, value: string, at: number }>, children: TemplateNode[], at: number }} TemplateNode */
/** @typedef {{ line: number, character: number }} Position */
/** @typedef {{ start: Position, end: Position }} Range */
/** @typedef {{ name: string, detail: string, kind: number, range: Range, selectionRange: Range, children: LspDocumentSymbol[] }} LspDocumentSymbol */
/** @typedef {{ name: string, kind: number, detail: string, documentation: string, location: { uri: string, range: Range } }} ClassSymbol */

const COMMON_ATTRIBUTES = [
  'class',
  'id',
  'title',
  'role',
  'slot',
  'hidden',
  'tabindex',
  'aria-label',
  'data-testid',
];

const COMMON_EVENTS = [
  'blur',
  'change',
  'click',
  'focus',
  'input',
  'keydown',
  'keyup',
  'pointerdown',
  'pointerup',
  'submit',
];

const DIRECTIVES = [
  {
    label: '*if',
    detail: 'Render this element when the expression is truthy.',
    insertText: '*if="$1"',
  },
  {
    label: '*else',
    detail: 'Render this element when the preceding *if is false.',
    insertText: '*else',
  },
  {
    label: '*for',
    detail: 'Repeat this element for an iterable, with an optional stable key.',
    insertText: '*for="${1:item} of ${2:items}; key: ${1:item}.${3:id}"',
  },
];

const TOKEN_TYPES = {
  event: 11,
  keyword: 15,
  method: 12,
  operator: 21,
  property: 9,
  variable: 8,
};

/**
 * One long-lived language service per repository root.
 */
export class SrlLanguageService {
  /** @type {Map<string, { languageId: string, version: number, text: string }>} */
  documents = new Map();
  /** @type {ProjectModel[]} */
  models = [];

  /** Rebuild project models after source, declarations, or import maps change. */
  async reload() {
    const discovered = await apps();
    const models = [];
    for (const app of discovered) models.push(await readProject(app));
    this.models = models;
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

  /** @param {ProjectModel} model @param {string} path @returns {ElementRecord | undefined} */
  component(model, path) {
    const claim = model.templates.get(path)?.claimedBy;
    if (claim !== undefined && claim !== null) return model.elements.get(claim);
    return [...model.elements.values()].find((element) => element.template === path);
  }

  /** @param {string} uri Inline template and project-model diagnostics for one editor document. */
  async diagnostics(uri) {
    const path = fromUri(uri);
    const model = this.model(uri);
    if (model === undefined) return [];
    const source = await this.source(uri);
    /** @type {Array<Diagnostic | import('../project-model/types.js').ProjectDiagnostic>} */
    const found = [];

    for (const project of this.models) {
      found.push(...project.diagnostics.filter((diagnostic) => diagnostic.file === path));
    }

    if (path.endsWith('.html')) {
      const component = this.component(model, path);
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
            }),
          );
        } catch (cause) {
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
    const tag = tagAt(source, offset);
    const opening = openingTagAt(source, offset);
    const expression = expressionAt(source, offset);

    if (tag !== undefined && tag.typed) return tagCompletions(model, component);
    if (expression !== undefined) {
      const symbols =
        component === undefined
          ? []
          : await classSymbols(component.module, component.className, this.documents);
      return expressionCompletions(symbols, model, source, offset, expression.attribute);
    }
    if (opening !== undefined) return attributeCompletions(model.elements.get(opening.tag));
    return [];
  }

  /** @param {string} uri @param {Position} position Hover over custom tags, public bindings, directives, and host members. */
  async hover(uri, position) {
    const source = await this.source(uri);
    const offset = offsetAt(source, position);
    const model = this.model(uri);
    if (model === undefined) return null;
    const tag = tagAt(source, offset);
    if (tag !== undefined) {
      const record = model.elements.get(tag.name);
      if (record !== undefined) return elementHover(record);
    }

    const attribute = attributeAt(source, offset);
    if (attribute !== undefined) {
      const record = model.elements.get(attribute.tag);
      const hover = attributeHover(attribute.name, record);
      if (hover !== null) return { contents: { kind: 'markdown', value: hover } };
    }

    const expression = expressionAt(source, offset);
    const component = this.component(model, fromUri(uri));
    if (expression === undefined || component === undefined) return null;
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
    const tag = tagAt(source, offset);
    if (tag !== undefined) {
      const record = model.elements.get(tag.name);
      if (record !== undefined) return [await elementLocation(record, this.documents)];
    }

    const attribute = attributeAt(source, offset);
    if (attribute !== undefined) {
      const record = model.elements.get(attribute.tag);
      const name = bindingName(attribute.name);
      if (record !== undefined && name !== null && record.properties.includes(name)) {
        const symbols = await classSymbols(record.module, record.className, this.documents);
        const symbol = symbols.find((candidate) => candidate.name === name);
        if (symbol !== undefined) return [symbol.location];
      }
    }

    const expression = expressionAt(source, offset);
    const component = this.component(model, fromUri(uri));
    const word = wordAt(source, offset);
    if (expression === undefined || component === undefined || word === undefined) return [];
    const symbols = await classSymbols(component.module, component.className, this.documents);
    const symbol = symbols.find((candidate) => candidate.name === word.text);
    if (symbol !== undefined) return [symbol.location];
    const global = model.globals.get(word.text);
    return global === undefined ? [] : [await moduleLocation(global.module, global.exportName, this.documents)];
  }

  /** @param {string} uri @param {Position} position @param {boolean} includeDeclaration Every use of a custom-element tag in templates, optionally including its declaration. */
  async references(uri, position, includeDeclaration) {
    const source = await this.source(uri);
    const model = this.model(uri);
    const tag = tagAt(source, offsetAt(source, position));
    if (model === undefined || tag === undefined || !model.elements.has(tag.name)) return [];
    const locations = [];
    const seen = new Set();
    for (const project of this.models) {
      for (const template of project.templates.values()) {
        if (seen.has(template.path)) continue;
        seen.add(template.path);
        const templateUri = toUri(template.path);
        const text = await this.source(templateUri);
        for (const span of tagSpans(text, tag.name)) {
          locations.push({ uri: templateUri, range: rangeAt(text, span.start, span.end) });
        }
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
    const tag = tagAt(source, offsetAt(source, position));
    const model = this.model(uri);
    if (tag === undefined || model?.elements.has(tag.name) !== true) return null;
    return { range: rangeAt(source, tag.start, tag.end), placeholder: tag.name };
  }

  /** @param {string} uri @param {{ line: number, character: number }} position @param {string} newName */
  async rename(uri, position, newName) {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/u.test(newName)) {
      throw new Error('An srl custom-element tag must contain a hyphen and use lowercase ASCII.');
    }
    const source = await this.source(uri);
    const model = this.model(uri);
    const tag = tagAt(source, offsetAt(source, position));
    if (model === undefined || tag === undefined) return null;
    const record = model.elements.get(tag.name);
    if (record === undefined) return null;

    /** @type {Record<string, Array<{ range: object, newText: string }>>} */
    const changes = {};
    const seen = new Set();
    for (const project of this.models) {
      for (const template of project.templates.values()) {
        if (seen.has(template.path)) continue;
        seen.add(template.path);
        const templateUri = toUri(template.path);
        const text = await this.source(templateUri);
        const edits = tagSpans(text, tag.name).map((span) => ({
          range: rangeAt(text, span.start, span.end),
          newText: newName,
        }));
        if (edits.length > 0) changes[templateUri] = edits;
      }
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
    return { data: encodeSemanticTokens(source, semanticSpans(source)) };
  }

  /** @param {string} uri Custom tag names link to their declaring JavaScript modules. */
  async documentLinks(uri) {
    const source = await this.source(uri);
    const model = this.model(uri);
    if (model === undefined || !fromUri(uri).endsWith('.html')) return [];
    const links = [];
    for (const [tag, record] of model.elements) {
      for (const span of tagSpans(source, tag)) {
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
    if (!fromUri(uri).endsWith('.html')) return [];
    let roots;
    try {
      roots = parseTemplate(source, fromUri(uri));
    } catch {
      return [];
    }
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
      if (diagnostic.code !== 'templates/dialect' || !/Add `[^`]+` to its `uses`/u.test(diagnostic.message)) {
        continue;
      }
      const start = offsetAt(source, range.start);
      const tag = tagAt(source, start) ?? tagAt(source, Math.min(source.length, start + 1));
      const target = tag === undefined ? undefined : model.elements.get(tag.name);
      if (target === undefined || !target.exported) continue;
      const edit = await addUseEdit(model, owner, target, this.documents);
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
        observedAttributes: record.observedAttributes,
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

/** @param {ElementRecord | undefined} record */
function attributeCompletions(record) {
  /** @type {Array<Record<string, unknown>>} */
  const found = DIRECTIVES.map((directive) => ({
    ...directive,
    kind: 14,
    insertTextFormat: 2,
  }));
  for (const event of COMMON_EVENTS) {
    found.push({
      label: `(${event})`,
      kind: 23,
      detail: 'srl event binding',
      insertText: `(${event})="$1"`,
      insertTextFormat: 2,
    });
  }
  for (const name of [...new Set([...COMMON_ATTRIBUTES, ...(record?.observedAttributes ?? [])])]) {
    found.push({
      label: name,
      kind: 10,
      detail: record?.observedAttributes?.includes(name) === true ? `${record.className} attribute` : 'HTML attribute',
      insertText: `${name}="$1"`,
      insertTextFormat: 2,
    });
    found.push({
      label: `[${name}]`,
      kind: 10,
      detail: 'srl attribute binding',
      insertText: `[${name}]="$1"`,
      insertTextFormat: 2,
    });
  }
  for (const property of record?.properties ?? []) {
    const kebab = kebabCase(property);
    found.push({
      label: `[.${kebab}]`,
      kind: 10,
      detail: `${record?.className ?? 'custom element'} property: ${property}`,
      insertText: `[.${kebab}]="$1"`,
      insertTextFormat: 2,
    });
  }
  return found;
}

/** @param {Awaited<ReturnType<typeof classSymbols>>} symbols @param {ProjectModel} model @param {string} source @param {number} offset @param {string | undefined} attribute */
function expressionCompletions(symbols, model, source, offset, attribute) {
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
  for (const local of loopLocals(source, offset)) {
    found.push({ label: local, kind: 6, detail: 'template loop local' });
  }
  if (attribute?.startsWith('(') === true) {
    found.push({ label: '$event', kind: 6, detail: 'typed DOM event' });
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
  return lines.join('\n');
}

/** @param {string} name @param {ElementRecord | undefined} record */
function attributeHover(name, record) {
  if (name === '*if') return '**`*if`** — renders this element when its expression is truthy.';
  if (name === '*else') return '**`*else`** — alternate for the preceding sibling carrying `*if`.';
  if (name === '*for') return '**`*for`** — iterates `item of items`; accepts `key:` and `index as` clauses.';
  if (name.startsWith('(') && name.endsWith(')')) return `**\`${name}\`** — typed DOM event binding; \`$event\` is in scope.`;
  const binding = bindingName(name);
  if (binding !== null && record?.properties.includes(binding) === true) {
    return `**\`${name}\`** — \`${record.className}.${binding}\` property binding.`;
  }
  if (name.startsWith('[?')) return `**\`${name}\`** — boolean attribute binding.`;
  if (name.startsWith('[')) return `**\`${name}\`** — attribute binding.`;
  if (record?.observedAttributes?.includes(name) === true) return `**\`${name}\`** — observed by \`${record.className}\`.`;
  return null;
}

/** @param {string} name */
function bindingName(name) {
  if (!name.startsWith('[.') || !name.endsWith(']')) return null;
  return camelCase(name.slice(2, -1));
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
function tagAt(source, offset) {
  const start = source.lastIndexOf('<', offset);
  if (start === -1 || source.lastIndexOf('>', offset) > start) return undefined;
  const match = /^<\/?([A-Za-z][\w:-]*)/u.exec(source.slice(start));
  if (match === null || match[1] === undefined) return undefined;
  const nameStart = start + match[0].indexOf(match[1]);
  const end = nameStart + match[1].length;
  if (offset < nameStart || offset > end) return undefined;
  return {
    name: match[1].toLowerCase(),
    start: nameStart,
    end,
    typed: !source.startsWith('</', start),
  };
}

/** @param {string} source @param {number} offset */
function openingTagAt(source, offset) {
  const start = source.lastIndexOf('<', offset);
  if (start === -1 || source.lastIndexOf('>', offset) > start || source.startsWith('</', start)) return undefined;
  const match = /^<([A-Za-z][\w:-]*)/u.exec(source.slice(start));
  if (match?.[1] === undefined) return undefined;
  return { tag: match[1].toLowerCase(), start };
}

/** @param {string} source @param {number} offset */
function attributeAt(source, offset) {
  const opening = openingTagAt(source, offset);
  if (opening === undefined) return undefined;
  const text = source.slice(opening.start, offset + 1);
  const attributesStart = text.indexOf(' ');
  if (attributesStart === -1) return undefined;
  const pattern = /[^\s=/>]+/gu;
  pattern.lastIndex = attributesStart;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const name = match[0];
    const start = opening.start + match.index;
    const end = start + name.length;
    if (start <= offset && offset <= end) return { tag: opening.tag, name, start, end };
    const next = text.slice(pattern.lastIndex).match(/^\s*=/u);
    if (next !== null) {
      const equals = pattern.lastIndex + next[0].length;
      const quote = text[equals];
      if (quote === '"' || quote === "'") {
        const close = text.indexOf(quote, equals + 1);
        pattern.lastIndex = close === -1 ? text.length : close + 1;
      }
    }
  }
  return undefined;
}

/** @param {string} source @param {number} offset */
function expressionAt(source, offset) {
  const interpolation = source.lastIndexOf('{{', offset);
  if (interpolation !== -1 && source.lastIndexOf('}}', offset) < interpolation) {
    return { start: interpolation + 2, attribute: undefined };
  }
  const opening = openingTagAt(source, offset);
  if (opening === undefined) return undefined;
  const before = source.slice(opening.start, offset + 1);
  const match = /([^\s=/>]+)\s*=\s*(["'])([^"']*)$/u.exec(before);
  if (match?.[1] === undefined) return undefined;
  const name = match[1].toLowerCase();
  if (
    !(name.startsWith('[') && name.endsWith(']')) &&
    !(name.startsWith('(') && name.endsWith(')')) &&
    name !== '*if' &&
    name !== '*for'
  ) return undefined;
  return { start: offset - (match[3]?.length ?? 0), attribute: name };
}

/** @param {string} source @param {number} offset */
function wordAt(source, offset) {
  let start = offset;
  let end = offset;
  while (start > 0 && /[A-Za-z0-9_$]/u.test(source[start - 1] ?? '')) start -= 1;
  while (end < source.length && /[A-Za-z0-9_$]/u.test(source[end] ?? '')) end += 1;
  return start === end ? undefined : { text: source.slice(start, end), start, end };
}

/** @param {string} source @param {number} offset */
function loopLocals(source, offset) {
  const locals = new Set(['$index', '$first', '$last', '$count']);
  const pattern = /\*for\s*=\s*["']\s*([A-Za-z_$][\w$]*)\s+of\b(?:[^"']*?\bindex\s+as\s+([A-Za-z_$][\w$]*))?/gu;
  for (const match of source.slice(0, offset).matchAll(pattern)) {
    if (match[1] !== undefined) locals.add(match[1]);
    if (match[2] !== undefined) locals.add(match[2]);
  }
  return [...locals];
}

/** @param {string} source */
function semanticSpans(source) {
  /** @type {Array<{ start: number, length: number, type: number }>} */
  const spans = [];
  addPattern(/\{\{|\}\}/gu, TOKEN_TYPES.operator);
  addPattern(/\*(?:if|else|for)\b/gu, TOKEN_TYPES.keyword);
  addCaptured(/\(([A-Za-z][\w:-]*)\)/gu, 1, TOKEN_TYPES.event);
  addCaptured(/\[([.?]?[A-Za-z][\w:-]*)\]/gu, 1, TOKEN_TYPES.property);
  for (const expression of expressionSpans(source)) {
    const text = source.slice(expression.start, expression.end);
    for (const match of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/gu)) {
      const start = expression.start + (match.index ?? 0);
      const after = text.slice((match.index ?? 0) + match[0].length).trimStart()[0];
      spans.push({
        start,
        length: match[0].length,
        type: after === '(' ? TOKEN_TYPES.method : TOKEN_TYPES.variable,
      });
    }
  }
  return spans
    .sort((left, right) => left.start - right.start || right.length - left.length)
    .filter((span, index, all) => index === 0 || span.start >= (all[index - 1]?.start ?? 0) + (all[index - 1]?.length ?? 0));

  /** @param {RegExp} pattern @param {number} type */
  function addPattern(pattern, type) {
    for (const match of source.matchAll(pattern)) {
      spans.push({ start: match.index ?? 0, length: match[0].length, type });
    }
  }

  /** @param {RegExp} pattern @param {number} group @param {number} type */
  function addCaptured(pattern, group, type) {
    for (const match of source.matchAll(pattern)) {
      const value = match[group];
      if (value === undefined) continue;
      spans.push({ start: (match.index ?? 0) + match[0].indexOf(value), length: value.length, type });
    }
  }
}

/** @param {string} source */
function expressionSpans(source) {
  const spans = [];
  for (const match of source.matchAll(/\{\{([\s\S]*?)\}\}/gu)) {
    const value = match[1] ?? '';
    const start = (match.index ?? 0) + match[0].indexOf(value);
    spans.push({ start, end: start + value.length });
  }
  for (const match of source.matchAll(/([^\s=/>]+)\s*=\s*(["'])([\s\S]*?)\2/gu)) {
    const name = (match[1] ?? '').toLowerCase();
    if (!name.startsWith('[') && !name.startsWith('(') && name !== '*if' && name !== '*for') continue;
    const value = match[3] ?? '';
    const start = (match.index ?? 0) + match[0].lastIndexOf(value);
    spans.push({ start, end: start + value.length });
  }
  return spans;
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

/** @param {string} source @param {string} tag */
function tagSpans(source, tag) {
  const spans = [];
  const pattern = new RegExp(`<\\/?(${escapeRegExp(tag)})(?=[\\s>/])`, 'giu');
  for (const match of source.matchAll(pattern)) {
    const value = match[1] ?? '';
    const start = (match.index ?? 0) + match[0].indexOf(value);
    spans.push({ start, end: start + value.length });
  }
  return spans;
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

/** @param {ProjectModel} model @param {ElementRecord} owner @param {ElementRecord} target @param {Map<string, { text: string }>} documents */
async function addUseEdit(model, owner, target, documents) {
  const uri = toUri(owner.module);
  const source = documents.get(uri)?.text ?? (await readFile(owner.module, 'utf8'));
  const tree = ts.createSourceFile(owner.module, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const object = definitionObject(tree, owner.className);
  if (object === undefined) return null;
  let localName = target.className;
  /** @type {Array<{ range: object, newText: string }>} */
  const edits = [];
  /** @type {ts.NamedImports | undefined} */
  let targetImport;
  /** @type {ts.ImportDeclaration | undefined} */
  let lastImport;
  /** @type {Map<string, ts.Expression>} */
  const imported = new Map();
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    lastImport = statement;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      imported.set(element.name.text, statement.moduleSpecifier);
      if (
        ts.isStringLiteralLike(statement.moduleSpecifier) &&
        resolveImport(model, owner.module, statement.moduleSpecifier.text) === target.module &&
        (element.propertyName?.text ?? element.name.text) === target.className
      ) {
        localName = element.name.text;
        targetImport = bindings;
      }
    }
  }
  const conflict = imported.get(localName);
  if (
    conflict !== undefined &&
    ts.isStringLiteralLike(conflict) &&
    resolveImport(model, owner.module, conflict.text) !== target.module
  ) return null;

  if (targetImport === undefined && conflict === undefined) {
    const specifier = importSpecifier(model, owner.module, target.module);
    const text = `import { ${target.className} } from ${JSON.stringify(specifier)};\n`;
    const at = lastImport?.end ?? 0;
    edits.push({
      range: rangeAt(source, at, at),
      newText: `${at === 0 ? '' : '\n'}${text}`,
    });
  }

  const uses = object.properties.find(
    (property) => ts.isPropertyAssignment(property) && nodeName(property.name) === 'uses',
  );
  if (uses !== undefined && ts.isPropertyAssignment(uses)) {
    if (!ts.isArrayLiteralExpression(uses.initializer)) return null;
    if (uses.initializer.elements.some((element) => ts.isIdentifier(element) && element.text === localName)) return null;
    const at = uses.initializer.end - 1;
    edits.push({
      range: rangeAt(source, at, at),
      newText: `${uses.initializer.elements.length === 0 ? '' : ', '}${localName}`,
    });
  } else {
    const last = object.properties.at(-1);
    if (last === undefined) return null;
    const tail = source.slice(last.end, object.end - 1);
    const comma = tail.indexOf(',');
    const multiline = source.slice(object.pos, object.end).includes('\n');
    const at = comma === -1 ? last.end : last.end + comma + 1;
    edits.push({
      range: rangeAt(source, at, at),
      newText: `${comma === -1 ? ',' : ''}${multiline ? `\n  uses: [${localName}],` : ` uses: [${localName}],`}`,
    });
  }
  return { changes: { [uri]: edits } };
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

/** @param {ProjectModel} model @param {string} from @param {string} specifier */
function resolveImport(model, from, specifier) {
  if (specifier.startsWith('.')) return resolve(dirname(from), specifier);
  for (const [prefix, directory] of Object.entries(model.prefixes)) {
    if (specifier.startsWith(prefix)) return resolve(directory, specifier.slice(prefix.length));
  }
  return undefined;
}

/** @param {ProjectModel} model @param {string} from @param {string} target */
function importSpecifier(model, from, target) {
  const prefixes = Object.entries(model.prefixes)
    .filter(([, directory]) => inside(target, directory))
    .sort((left, right) => right[1].length - left[1].length);
  const chosen = prefixes[0];
  if (chosen !== undefined) return `${chosen[0]}${relative(chosen[1], target).split(sep).join('/')}`;
  let path = relative(dirname(from), target).split(sep).join('/');
  if (!path.startsWith('.')) path = `./${path}`;
  return path;
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

/** @param {string} source @param {number} offset */
function positionAt(source, offset) {
  const before = source.slice(0, Math.max(0, offset));
  const line = before.split('\n').length - 1;
  const last = before.lastIndexOf('\n');
  return { line, character: before.length - last - 1 };
}

/** @param {Diagnostic | import('../project-model/types.js').ProjectDiagnostic} diagnostic @param {string} source */
function lspDiagnostic(diagnostic, source) {
  const line = 'line' in diagnostic && diagnostic.line !== null ? Math.max(0, diagnostic.line - 1) : 0;
  const character = 'column' in diagnostic && diagnostic.column !== null ? Math.max(0, diagnostic.column - 1) : 0;
  const lineText = source.split('\n')[line] ?? '';
  let end = character;
  while (end < lineText.length && /[^\s"'<>={}]/u.test(lineText[end] ?? '')) end += 1;
  if (end === character) end = Math.min(lineText.length, character + 1);
  const severity = diagnostic.severity === 'error' ? 1 : diagnostic.severity === 'warning' ? 2 : 3;
  return {
    range: { start: { line, character }, end: { line, character: end } },
    severity,
    code: 'code' in diagnostic ? diagnostic.code : `project/${diagnostic.kind}`,
    source: 'srl',
    message: diagnostic.message,
  };
}

/** @param {Array<Diagnostic | import('../project-model/types.js').ProjectDiagnostic>} diagnostics @returns {Array<Diagnostic | import('../project-model/types.js').ProjectDiagnostic>} */
function uniqueDiagnostics(diagnostics) {
  return uniqueBy(diagnostics, (diagnostic) =>
    [
      'code' in diagnostic ? diagnostic.code : diagnostic.kind,
      diagnostic.message,
      'line' in diagnostic ? diagnostic.line : '',
      'column' in diagnostic ? diagnostic.column : '',
    ].join('\0'),
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

/** @param {string} value */
function camelCase(value) {
  return value.replace(/-([a-z])/gu, (_all, character) => String(character).toUpperCase());
}

/** @param {string} value */
function kebabCase(value) {
  return value.replace(/[A-Z]/gu, (character) => `-${character.toLowerCase()}`);
}

/** @param {string} value */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
