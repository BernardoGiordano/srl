/**
 * One interpretation of an authored template for every editor feature.
 *
 * The checker remains the second implementation of the runtime dialect: it emits
 * TypeScript and reports diagnostics. This module owns the editor-facing meaning of
 * incomplete source. It scans once, keeps scopes and exact source ranges together, and
 * asks the checker's compiler for member types. Callers do not search backwards with a
 * feature-specific regular expression. ADR-0092.
 *
 * Element nesting, tag spans and attribute spans are HTML, so both authored forms read
 * them from the same scan. The `dialect` selects what else the scan means: srl records
 * `{{ }}` and directive expressions, Lit records none because its substitutions are the
 * module's own JavaScript and TypeScript already types them.
 */

import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

import {
  classifyAttributeName,
  FOR_HEAD,
  FOR_INDEX_CLAUSE,
  FOR_KEY_CLAUSE,
  parseFragmentHead,
  VOID_ELEMENTS,
} from '@srljs/core/lib/core/template/dialect.js';
import { templateExpressionMembers } from '../checks/template-check.mjs';

/** @import { ElementRecord, ProjectModel } from '../project-model/types.js' */

/** @typedef {{ name: string, value: string, at: number, nameStart: number, nameEnd: number, valueStart: number, valueEnd: number }} Attribute */
/** @typedef {{ kind: 'text', value: string, at: number } | ElementNode} TemplateNode */
/** @typedef {{ kind: 'element', tag: string, attributes: Attribute[], children: TemplateNode[], at: number, nameStart: number, nameEnd: number, openEnd: number, end: number }} ElementNode */
/** @typedef {'srl' | 'lit'} Dialect */
/** @typedef {{ name: string, start: number, end: number, opening: boolean }} TagSpan */
/** @typedef {{ start: number, end: number, attribute: string | undefined, element: ElementNode | undefined, event: string | undefined }} ExpressionSpan */
/** @typedef {{ alias: string, iterable: string, indexAlias: string | undefined, at: number }} LoopScope */
/** @typedef {{ tag: string, property: string, at: number,
 *   params: Array<{ name: string, iterable: string | undefined }> }} FragmentScope */

const RAW_TEXT_ELEMENTS = new Set(['script', 'style']);

/**
 * Member types depend on project identity and open JavaScript, but not on each character
 * typed after the member-access dot. Cache that answer across semantic snapshots so
 * `rows.`, `rows.l`, and `rows.le` pay for one compiler query. The documents map owns the
 * lifetime, model identity owns reload invalidation, and document object identity owns
 * overlay invalidation.
 *
 * @type {WeakMap<Map<string, object>, WeakMap<ProjectModel, {
 *   files: Map<string, object>,
 *   values: Map<string, Array<{ label: string, kind: number, detail: string, documentation: string }>>,
 * }>>}
 */
const memberCaches = new WeakMap();

/**
 * Semantic snapshot of one possibly incomplete template.
 *
 * Construction performs all source scanning. Queries are then synchronous except member
 * completion, which enters the cached TypeScript compiler through the checker.
 */
export class TemplateSemantics {
  /** @type {string} */
  source;
  /** @type {TemplateNode[]} */
  roots;
  /** @type {ElementNode[]} */
  #elements;
  /** @type {TagSpan[]} */
  #tags;
  /** @type {ExpressionSpan[]} */
  #expressions;
  /** @type {ProjectModel} */
  #model;
  /** @type {ElementRecord | undefined} */
  #component;
  /** @type {Map<string, { text: string, version?: number }>} */
  #documents;
  #where;

  /**
   * @param {{
   *   source: string,
   *   where: string,
   *   model: ProjectModel,
   *   component?: ElementRecord,
   *   documents: Map<string, { text: string, version?: number }>,
   *   dialect?: Dialect,
   * }} input
   */
  constructor(input) {
    this.source = input.source;
    this.#where = input.where;
    this.#model = input.model;
    this.#component = input.component;
    this.#documents = input.documents;
    const scanned = scanTemplate(input.source, input.dialect ?? 'srl');
    this.roots = scanned.roots;
    this.#elements = scanned.elements;
    this.#tags = scanned.tags;
    this.#expressions = scanned.expressions;
  }

  /**
   * Meaning at one source offset. Expression wins over punctuation inside it, so
   * comparisons and quotes cannot turn expression completion into tag or attribute
   * completion.
   *
   * @param {number} offset
   */
  at(offset) {
    const expression = narrowest(this.#expressions, offset);
    if (expression !== undefined) {
      const loops = this.#loopsAt(offset, expression);
      const fragments = this.#fragmentsAt(offset, expression);
      return {
        kind: /** @type {const} */ ('expression'),
        start: expression.start,
        end: expression.end,
        attribute: expression.attribute,
        event: expression.event,
        tag: expression.element?.tag,
        loops,
        fragments,
        locals: localNames(loops, fragments, expression.event !== undefined),
      };
    }

    const tag = this.#tags.find((candidate) => candidate.start <= offset && offset <= candidate.end);
    if (tag !== undefined) return { kind: /** @type {const} */ ('tag'), ...tag, typed: tag.opening };

    const partial = this.#partialTagAt(offset);
    if (partial !== undefined) return { kind: /** @type {const} */ ('tag'), ...partial };

    for (const element of this.#elements) {
      const valued = element.attributes.find(
        (attribute) =>
          attribute.valueStart <= offset &&
          offset <= attribute.valueEnd &&
          attribute.valueStart !== attribute.nameEnd,
      );
      if (valued === undefined) continue;
      const parent = innermost(
        this.#elements.filter(
          (candidate) =>
            candidate !== element &&
            candidate.at < element.at &&
            element.end <= candidate.end,
        ),
      );
      return {
        kind: /** @type {const} */ ('attribute-value'),
        tag: element.tag,
        name: valued.name,
        value: valued.value,
        start: valued.valueStart,
        end: valued.valueEnd,
        parentTag: parent?.tag,
      };
    }

    const element = innermost(
      this.#elements.filter(
        (candidate) => candidate.at <= offset && offset <= candidate.openEnd,
      ),
    );
    if (element === undefined) return { kind: /** @type {const} */ ('text') };
    const attribute = element.attributes.find(
      (candidate) => candidate.nameStart <= offset && offset <= candidate.nameEnd,
    );
    if (attribute !== undefined) {
      return {
        kind: /** @type {const} */ ('attribute'),
        tag: element.tag,
        name: attribute.name,
        start: attribute.nameStart,
        end: attribute.nameEnd,
      };
    }
    return { kind: /** @type {const} */ ('opening-tag'), tag: element.tag, start: element.at };
  }

  /** @param {string} name Actual start and end tag names, excluding comments and raw script/style text. */
  tags(name) {
    return this.#tags
      .filter((candidate) => candidate.name === name)
      .map(({ start, end }) => ({ start, end }));
  }

  /** Every parsed tag name, opening and closing, in source order. */
  tagSpans() {
    return this.#tags.map((span) => ({ ...span }));
  }

  /** Every parsed attribute name and the tag carrying it, in source order. */
  attributeSpans() {
    return this.#elements.flatMap((element) =>
      element.attributes.map((attribute) => ({
        tag: element.tag,
        name: attribute.name,
        start: attribute.nameStart,
        end: attribute.nameEnd,
      })),
    );
  }

  /** Expression ranges used by semantic highlighting. */
  expressionSpans() {
    return this.#expressions.map(({ start, end }) => ({ start, end }));
  }

  /**
   * Compiler-backed properties of the value left of the member-access dot at `offset`.
   * `undefined` means root-name completion; an array, including an empty one, means a
   * member access was recognized.
   *
   * @param {number} offset
   */
  membersAt(offset) {
    const context = this.at(offset);
    if (context.kind !== 'expression' || this.#component === undefined) return undefined;
    const component = this.#component;
    const prefix = this.source.slice(context.start, Math.min(offset, context.end));
    const target = memberTarget(prefix);
    if (target === undefined) return undefined;
    try {
      const key = JSON.stringify({
        component: [component.module, component.className],
        target,
        loops: context.loops,
        fragments: context.fragments,
        event: context.event === undefined ? undefined : [context.tag, context.event],
      });
      return cachedMembers(this.#documents, this.#model, key, () =>
        templateExpressionMembers({
          module: component.module,
          className: component.className,
          template: this.#where,
          expression: target,
          loops: context.loops,
          fragments: context.fragments,
          event:
            context.event === undefined || context.tag === undefined
              ? undefined
              : { name: context.event, tag: context.tag },
          elements: checkerElements(this.#model),
          globals: this.#model.globals,
          files: openJavaScript(this.#documents),
        }),
      );
    } catch {
      // Incomplete source is expected while completion is requested. Root names remain
      // useful if the expression to the left of the dot is not parseable yet.
      return undefined;
    }
  }

  /**
   * Plan an import plus a structural update to a component's `uses` array.
   *
   * @param {ElementRecord} target
   */
  async addUse(target) {
    const owner = this.#component;
    if (owner === undefined) return null;
    const uri = toUri(owner.module);
    const source = this.#documents.get(uri)?.text ?? (await readFile(owner.module, 'utf8'));
    const tree = ts.createSourceFile(owner.module, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const object = definitionObject(tree, owner.className);
    if (object === undefined) return null;
    let localName = target.className;
    /** @type {Array<{ range: { start: { line: number, character: number }, end: { line: number, character: number } }, newText: string }>} */
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
          resolveImport(this.#model, owner.module, statement.moduleSpecifier.text) === target.module &&
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
      resolveImport(this.#model, owner.module, conflict.text) !== target.module
    ) return null;

    if (targetImport === undefined && conflict === undefined) {
      const specifier = importSpecifier(this.#model, owner.module, target.module);
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
      if (
        uses.initializer.elements.some(
          (element) => ts.isIdentifier(element) && element.text === localName,
        )
      ) return null;
      const elements = ts.factory.createNodeArray(
        [...uses.initializer.elements, ts.factory.createIdentifier(localName)],
        uses.initializer.elements.hasTrailingComma,
      );
      const replacement = ts.factory.updateArrayLiteralExpression(uses.initializer, elements);
      const printed = ts.createPrinter().printNode(ts.EmitHint.Expression, replacement, tree);
      edits.push({
        range: rangeAt(source, uses.initializer.getStart(tree), uses.initializer.end),
        newText: printed,
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

  /** @param {number} offset @param {ExpressionSpan} expression */
  #loopsAt(offset, expression) {
    /** @type {LoopScope[]} */
    const loops = [];
    const ancestors = this.#elements
      .filter((element) => element.at <= offset && offset <= element.end)
      .sort((left, right) => left.at - right.at);
    for (const element of ancestors) {
      const attribute = element.attributes.find((candidate) => candidate.name === '*for');
      if (attribute === undefined || expression.start === attribute.valueStart) continue;
      const [head = '', ...clauses] = attribute.value.split(';');
      const parsed = FOR_HEAD.exec(head);
      if (parsed?.[1] === undefined || parsed[2] === undefined) continue;
      let indexAlias;
      for (const clause of clauses) {
        const candidate = FOR_INDEX_CLAUSE.exec(clause.trim())?.[1];
        if (candidate !== undefined) indexAlias = candidate;
      }
      loops.push({ alias: parsed[1], iterable: parsed[2], indexAlias, at: element.at });
    }
    return loops;
  }

  /**
   * Fragment scopes an offset sits inside.
   *
   * The property whose signature types the locals belongs to the *parent* element,
   * not to the `<template>` that carries the body, because that is the element the
   * fragment is assigned to and eventually called by.
   *
   * @param {number} offset @param {ExpressionSpan} expression
   * @returns {FragmentScope[]}
   */
  #fragmentsAt(offset, expression) {
    /** @type {FragmentScope[]} */
    const fragments = [];
    const ancestors = this.#elements
      .filter((element) => element.at <= offset && offset <= element.end)
      .sort((left, right) => left.at - right.at);

    for (const element of ancestors) {
      if (element.tag !== 'template') continue;
      const attribute = element.attributes.find((candidate) => candidate.name === '*fragment');
      if (attribute === undefined) continue;
      // The head's own `of` expressions are read in the enclosing scope, so they
      // must not see the locals this fragment introduces.
      if (expression.start >= attribute.valueStart && expression.end <= attribute.valueEnd) continue;

      const head = readFragmentHead(attribute.value);
      if (head === undefined) continue;
      const parent = innermost(
        this.#elements.filter(
          (candidate) =>
            candidate !== element && candidate.at < element.at && element.end <= candidate.end,
        ),
      );
      if (parent === undefined) continue;

      fragments.push({
        tag: parent.tag,
        property: head.property,
        params: head.params,
        at: element.at,
      });
    }
    return fragments;
  }

  /** @param {number} offset */
  #partialTagAt(offset) {
    const start = this.source.lastIndexOf('<', offset);
    if (start === -1) return undefined;
    if (this.#expressions.some((candidate) => candidate.start <= start && start <= candidate.end)) {
      return undefined;
    }
    const text = this.source.slice(start, offset);
    const match = /^<([A-Za-z][\w:-]*)?$/u.exec(text);
    if (match === null) return undefined;
    const value = match[1] ?? '';
    return {
      name: value.toLowerCase(),
      start: start + 1,
      end: offset,
      opening: true,
      typed: true,
    };
  }
}

/**
 * @param {Map<string, { text: string, version?: number }>} documents
 * @param {ProjectModel} model
 * @param {string} key
 * @param {() => Array<{ label: string, kind: number, detail: string, documentation: string }>} read
 */
function cachedMembers(documents, model, key, read) {
  let byModel = memberCaches.get(documents);
  if (byModel === undefined) {
    byModel = new WeakMap();
    memberCaches.set(documents, byModel);
  }
  let cache = byModel.get(model);
  if (cache === undefined || !sameJavaScriptDocuments(cache.files, documents)) {
    cache = { files: javaScriptDocuments(documents), values: new Map() };
    byModel.set(model, cache);
  }
  const existing = cache.values.get(key);
  if (existing !== undefined) return existing;
  const value = read();
  cache.values.set(key, value);
  if (cache.values.size > 128) cache.values.delete(cache.values.keys().next().value ?? '');
  return value;
}

/** @param {Map<string, object>} previous @param {Map<string, { text: string, version?: number }>} documents */
function sameJavaScriptDocuments(previous, documents) {
  const current = javaScriptDocuments(documents);
  if (previous.size !== current.size) return false;
  for (const [uri, document] of previous) {
    if (current.get(uri) !== document) return false;
  }
  return true;
}

/** @param {Map<string, { text: string, version?: number }>} documents */
function javaScriptDocuments(documents) {
  return new Map([...documents].filter(([uri]) => /\.m?js$/u.test(fromUri(uri))));
}

/**
 * The inline Lit markup of one JavaScript module, at the module's own offsets.
 *
 * A handwritten Lit component writes its markup in tagged templates instead of a sibling
 * `.html` file, so a scan that visits template files alone reports no uses for markup
 * that is genuinely there, and a rename built from that scan leaves those uses naming a
 * tag nothing defines any more. Searching the module text instead would edit the tag
 * written in an import comment or a string.
 *
 * The literal chunks of every markup template are copied into a blank of the module's
 * own length, so what the shared scanner reads is markup only and the spans it reports
 * are already offsets into the module. A template nested in a substitution is another
 * tagged template, copied by the same walk; code, comments and strings stay blank.
 *
 * A substitution becomes `$` padding rather than blank. `.rows=${rows}` is one binding
 * whose value happens to be JavaScript, and blanking it left the scanner reading the
 * next attribute name as that binding's unquoted value. The padding is the substitution's
 * own length, so every span stays at its module offset and an offset inside the
 * substitution reports the binding it belongs to.
 *
 * @param {string} source
 * @returns {string | null} Null when the module writes no markup at all.
 */
export function litSource(source) {
  if (!source.includes('`')) return null;
  const tree = ts.createSourceFile('module.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const markupTags = markupTagNames(tree);
  const blank = new Array(source.length).fill(' ');
  let found = false;

  /** @param {number} start @param {number} end */
  const keep = (start, end) => {
    found = true;
    for (let index = start; index < end; index += 1) blank[index] = source[index];
  };

  /** @param {number} start @param {number} end */
  const pad = (start, end) => {
    for (let index = start; index < end; index += 1) blank[index] = '$';
  };

  /** @param {ts.Node} node */
  const visit = (node) => {
    if (ts.isTaggedTemplateExpression(node) && ts.isIdentifier(node.tag) && markupTags.has(node.tag.text)) {
      const literal = node.template;
      if (ts.isNoSubstitutionTemplateLiteral(literal)) keep(literal.getStart(tree) + 1, literal.getEnd() - 1);
      else {
        // A head or middle chunk ends with the `${` that opens the next substitution,
        // which is padded here and overwritten again by any markup nested inside it.
        keep(literal.head.getStart(tree) + 1, literal.head.getEnd() - 2);
        let opener = literal.head.getEnd() - 2;
        for (const span of literal.templateSpans) {
          const closing = span.literal.kind === ts.SyntaxKind.TemplateTail ? 1 : 2;
          pad(opener, span.literal.getStart(tree) + 1);
          keep(span.literal.getStart(tree) + 1, span.literal.getEnd() - closing);
          opener = span.literal.getEnd() - closing;
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(tree, visit);
  return found ? blank.join('') : null;
}

/**
 * The local names that tag markup in this module. `html` and `svg` are the names Lit
 * documents, and both are markup; either may arrive under an alias, and a renamed import
 * writes the same templates.
 *
 * @param {ts.SourceFile} tree
 */
function markupTagNames(tree) {
  const names = new Set(['html', 'svg']);
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (imported === 'html' || imported === 'svg') names.add(element.name.text);
    }
  }
  return names;
}

/** @param {string} source @param {Dialect} dialect */
function scanTemplate(source, dialect = 'srl') {
  /** @type {TemplateNode[]} */
  const roots = [];
  /** @type {ElementNode[]} */
  const elements = [];
  /** @type {TagSpan[]} */
  const tags = [];
  /** @type {ExpressionSpan[]} */
  const expressions = [];
  /** @type {Array<{ tag: string, children: TemplateNode[], node: ElementNode | undefined }>} */
  const stack = [{ tag: '', children: roots, node: undefined }];
  const lower = source.toLowerCase();
  let index = 0;

  while (index < source.length) {
    const raw = stack.at(-1)?.tag;
    if (raw !== undefined && RAW_TEXT_ELEMENTS.has(raw)) {
      const close = lower.indexOf(`</${raw}`, index);
      const stop = close === -1 ? source.length : close;
      if (stop > index) stack.at(-1)?.children.push({ kind: 'text', value: source.slice(index, stop), at: index });
      index = stop;
      if (close === -1) break;
    }

    if (source.startsWith('<!--', index)) {
      const end = source.indexOf('-->', index + 4);
      index = end === -1 ? source.length : end + 3;
      continue;
    }

    if (dialect === 'srl' && source.startsWith('{{', index)) {
      const close = source.indexOf('}}', index + 2);
      const end = close === -1 ? source.length : close + 2;
      stack.at(-1)?.children.push({ kind: 'text', value: source.slice(index, end), at: index });
      expressions.push({
        start: index + 2,
        end: close === -1 ? source.length : close,
        attribute: undefined,
        element: stack.at(-1)?.node,
        event: undefined,
      });
      index = end;
      continue;
    }

    if (source[index] !== '<') {
      const tag = source.indexOf('<', index);
      const interpolation = dialect === 'srl' ? source.indexOf('{{', index) : -1;
      const candidates = [tag, interpolation].filter((candidate) => candidate !== -1);
      const stop = candidates.length === 0 ? source.length : Math.min(...candidates);
      stack.at(-1)?.children.push({ kind: 'text', value: source.slice(index, stop), at: index });
      index = stop;
      continue;
    }

    if (source.startsWith('</', index)) {
      const match = /^<\/\s*([A-Za-z][\w:-]*)/u.exec(source.slice(index));
      if (match?.[1] === undefined) {
        index += 1;
        continue;
      }
      const name = match[1].toLowerCase();
      const nameStart = index + match[0].lastIndexOf(match[1]);
      tags.push({ name, start: nameStart, end: nameStart + match[1].length, opening: false });
      const close = tagEnd(source, nameStart + match[1].length);
      const end = close === -1 ? source.length : close + 1;
      while (stack.length > 1) {
        const open = stack.pop();
        if (open?.node !== undefined) open.node.end = end;
        if (open?.tag === name) break;
      }
      index = Math.max(index + 2, end);
      continue;
    }

    if (source.startsWith('<!', index) || source.startsWith('<?', index)) {
      const end = source.indexOf('>', index + 2);
      index = end === -1 ? source.length : end + 1;
      continue;
    }

    const head = /^<\s*([A-Za-z][\w:-]*)/u.exec(source.slice(index));
    if (head?.[1] === undefined) {
      index += 1;
      continue;
    }
    const tag = head[1].toLowerCase();
    const nameStart = index + head[0].lastIndexOf(head[1]);
    const close = tagEnd(source, nameStart + head[1].length);
    const openEnd = close === -1 ? source.length : close + 1;
    const attributes = parseAttributes(source, nameStart + head[1].length, close === -1 ? source.length : close, dialect);
    const node = {
      kind: /** @type {const} */ ('element'),
      tag,
      attributes,
      children: [],
      at: index,
      nameStart,
      nameEnd: nameStart + head[1].length,
      openEnd,
      end: source.length,
    };
    elements.push(node);
    stack.at(-1)?.children.push(node);
    tags.push({ name: tag, start: node.nameStart, end: node.nameEnd, opening: true });
    if (dialect === 'srl') recordAttributeExpressions(expressions, node);

    const inside = source.slice(nameStart + head[1].length, close === -1 ? source.length : close);
    const selfClosing = /\/\s*$/u.test(inside);
    if (close !== -1 && !selfClosing && !VOID_ELEMENTS.has(tag)) {
      stack.push({ tag, children: node.children, node });
    } else node.end = openEnd;
    index = openEnd;
  }

  return { roots, elements, tags, expressions };
}

/** @param {ExpressionSpan[]} expressions @param {ElementNode} element */
function recordAttributeExpressions(expressions, element) {
  for (const attribute of element.attributes) {
    const syntax = classifyAttributeName(attribute.name);
    if (attribute.name === '*for') {
      const [head = '', ...clauses] = attribute.value.split(';');
      const parsed = FOR_HEAD.exec(head);
      if (parsed?.[2] !== undefined) {
        const at = attribute.valueStart + head.indexOf(parsed[2]);
        expressions.push({ start: at, end: at + parsed[2].length, attribute: attribute.name, element, event: undefined });
      }
      let search = head.length + 1;
      for (const clause of clauses) {
        const key = FOR_KEY_CLAUSE.exec(clause.trim())?.[1];
        if (key !== undefined) {
          const at = attribute.valueStart + attribute.value.indexOf(key, search);
          expressions.push({ start: at, end: at + key.length, attribute: attribute.name, element, event: undefined });
        }
        search += clause.length + 1;
      }
      continue;
    }
    if (attribute.name === '*fragment') {
      // Only the `of` clauses are expressions. The property name and the parameter
      // names are declarations, and offering completion inside them would offer
      // the host's members where a new name is being written.
      const head = readFragmentHead(attribute.value);
      let search = 0;
      for (const param of head?.params ?? []) {
        if (param.iterable === undefined) continue;
        const at = attribute.valueStart + attribute.value.indexOf(param.iterable, search);
        search = at - attribute.valueStart + param.iterable.length;
        expressions.push({ start: at, end: at + param.iterable.length, attribute: attribute.name, element, event: undefined });
      }
      continue;
    }
    if (syntax.kind === 'event' || syntax.kind === 'binding' || attribute.name === '*if') {
      expressions.push({
        start: attribute.valueStart,
        end: attribute.valueEnd,
        attribute: attribute.name,
        element,
        event: syntax.kind === 'event' ? syntax.event : undefined,
      });
      continue;
    }
    for (const match of attribute.value.matchAll(/\{\{([\s\S]*?)(?:\}\}|$)/gu)) {
      const value = match[1] ?? '';
      const start = attribute.valueStart + (match.index ?? 0) + 2;
      expressions.push({ start, end: start + value.length, attribute: attribute.name, element, event: undefined });
    }
  }
}

/**
 * Attribute names are lowercased for srl, whose property bindings are written in kebab
 * case, and kept verbatim for Lit, where `.optionRenderer` names the property itself.
 *
 * @param {string} source @param {number} from @param {number} end @param {Dialect} dialect
 */
function parseAttributes(source, from, end, dialect = 'srl') {
  /** @type {Attribute[]} */
  const attributes = [];
  let index = from;
  while (index < end) {
    while (/\s/u.test(source[index] ?? '')) index += 1;
    if (source[index] === '/' || index >= end) break;
    const match = /^[^\s=/>]+/u.exec(source.slice(index, end));
    if (match === null) {
      index += 1;
      continue;
    }
    const nameStart = index;
    const name = dialect === 'lit' ? match[0] : match[0].toLowerCase();
    index += match[0].length;
    const nameEnd = index;
    while (/\s/u.test(source[index] ?? '')) index += 1;
    if (source[index] !== '=') {
      attributes.push({ name, value: '', at: nameStart, nameStart, nameEnd, valueStart: nameEnd, valueEnd: nameEnd });
      continue;
    }
    index += 1;
    while (/\s/u.test(source[index] ?? '')) index += 1;
    const quote = source[index];
    let valueStart = index;
    let valueEnd;
    if (quote === '"' || quote === "'") {
      valueStart += 1;
      const close = source.indexOf(quote, valueStart);
      valueEnd = close === -1 || close > end ? end : close;
      index = valueEnd === end ? end : valueEnd + 1;
    } else {
      const value = /^[^\s>]+/u.exec(source.slice(index, end))?.[0] ?? '';
      valueEnd = index + value.length;
      index = valueEnd;
    }
    attributes.push({
      name,
      value: source.slice(valueStart, valueEnd),
      at: valueStart,
      nameStart,
      nameEnd,
      valueStart,
      valueEnd,
    });
  }
  return attributes;
}

/** @param {string} source @param {number} from */
function tagEnd(source, from) {
  /** @type {string | undefined} */
  let quote;
  for (let index = from; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '>') return index;
  }
  return -1;
}

/** @param {ExpressionSpan[]} spans @param {number} offset */
function narrowest(spans, offset) {
  return spans
    .filter((candidate) => candidate.start <= offset && offset <= candidate.end)
    .sort((left, right) => left.end - left.start - (right.end - right.start))[0];
}

/**
 * A `*fragment` head, read the way an editor needs it.
 *
 * The dialect's parser wants the closing parenthesis, and rightly so — the runtime
 * and the checker must refuse `*fragment="cell(row"`. An editor sees that text on
 * the way to the finished one, so a head still being typed is closed here and read
 * with the same grammar rather than a second, looser one.
 *
 * @param {string} value
 */
function readFragmentHead(value) {
  return parseFragmentHead(value) ?? parseFragmentHead(`${value})`);
}

/** @param {ElementNode[]} elements */
function innermost(elements) {
  return elements.sort((left, right) => right.at - left.at)[0];
}

/** @param {LoopScope[]} loops @param {FragmentScope[]} fragments @param {boolean} event */
function localNames(loops, fragments, event) {
  /** @type {Set<string>} */
  const found = new Set();
  for (const loop of loops) {
    found.add(loop.alias);
    found.add('$index');
    found.add('$first');
    found.add('$last');
    found.add('$count');
    if (loop.indexAlias !== undefined) found.add(loop.indexAlias);
  }
  for (const fragment of fragments) {
    for (const param of fragment.params) found.add(param.name);
  }
  if (event) found.add('$event');
  return [...found];
}

/** @param {string} prefix */
function memberTarget(prefix) {
  const match = /^([\s\S]+)(?:\?\.|\.)(?:[A-Za-z_$][A-Za-z0-9_$]*)?$/u.exec(prefix.trimEnd());
  return match?.[1]?.trim();
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

/** @param {Map<string, { text: string, version?: number }>} documents */
function openJavaScript(documents) {
  return new Map(
    [...documents.entries()]
      .filter(([uri]) => /\.m?js$/u.test(fromUri(uri)))
      .map(([uri, document]) => [fromUri(uri), document.text]),
  );
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

/** @param {ts.Expression} expression @returns {string} */
function calledName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return `${calledName(expression.expression)}.${expression.name.text}`;
  return '';
}

/** @param {ts.PropertyName | ts.BindingName | undefined} node */
function nodeName(node) {
  if (node === undefined) return undefined;
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
  return undefined;
}

/** @param {string} source @param {number} start @param {number} end */
function rangeAt(source, start, end) {
  return { start: positionAt(source, start), end: positionAt(source, end) };
}

/** @param {string} source @param {number} offset */
function positionAt(source, offset) {
  const before = source.slice(0, Math.max(0, offset));
  const line = before.split('\n').length - 1;
  const last = before.lastIndexOf('\n');
  return { line, character: before.length - last - 1 };
}

/** @param {string} path */
function toUri(path) {
  return pathToFileURL(path).href;
}

/** @param {string} uri */
function fromUri(uri) {
  return fileURLToPath(uri);
}

/** @param {string} path @param {string} directory */
function inside(path, directory) {
  const route = relative(directory, path);
  return route === '' || (!route.startsWith('..') && !route.startsWith(sep));
}
