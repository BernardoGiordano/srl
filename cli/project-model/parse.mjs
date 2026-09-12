/**
 * One JavaScript module, read once.
 *
 * Element identity starts at top level: classes, imports, `defineComponent({ ... })`,
 * `customElements.define('x-y', Class)` and `registerTemplateGlobals({ ... })`. Element
 * meaning also includes static property fields/getters, events dispatched by instance
 * methods, and the instance methods and fields a class declares under its own name.
 * This module turns one file into those authored facts and nothing else — no
 * template ownership, no cross-module inheritance resolution, no diagnostics about the
 * project as a whole. Those need every file, so they live in index.mjs.
 *
 * An AST rather than a regular expression, and a declaration whose tag, class or
 * template is computed is reported as `dynamic` rather than skipped. ADR-0038.
 *
 * THE CACHE
 *
 * Keyed by path, size and mtime. One process that reads the same file twice — the
 * template checker validating unsaved markup against a model it already built, both
 * applications' models in one verifier run — parses it once. TypeScript's own parse of a
 * 1,300-line component is the expensive part, not the disk read.
 */

import { stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

import { readText } from '../layout.mjs';

/**
 * One `defineComponent` or `customElements.define` call, exactly as written.
 *
 * @typedef {{
 *   kind: import('./types.js').DefinitionKind,
 *   className: string,
 *   tag: string,
 *   template: string | undefined,
 *   templateDeclared: boolean,
 *   uses: string[],
 * }} RawDefinition
 */

/**
 * @typedef {{
 *   name: string,
 *   kind: 'input' | 'state' | 'unknown',
 *   attribute: string | false | null,
 *   line: number,
 *   column: number,
 * }} RawProperty
 * @typedef {{
 *   name: string,
 *   event: 'Event' | 'CustomEvent',
 *   detail: import('./types.js').ElementEventDetail,
 *   line: number,
 *   column: number,
 * }} RawEvent
 * @typedef {{
 *   name: string,
 *   callable: boolean | null,
 *   line: number,
 *   column: number,
 * }} RawField
 * @typedef {{
 *   superclass: string | null,
 *   inheritanceKnown: boolean,
 *   methods: string[],
 *   fields: RawField[],
 *   properties: RawProperty[],
 *   propertiesKnown: boolean,
 *   observedAttributes: string[],
 *   attributesDeclared: boolean,
 *   attributesIncludeSuper: boolean,
 *   attributesKnown: boolean,
 *   events: RawEvent[],
 *   eventsKnown: boolean,
 * }} RawElementSurface
 * @typedef {{
 *   path: string,
 *   imports: Map<string, string>,
 *   importNames: Map<string, string>,
 *   sideEffectImports: Set<string>,
 *   classes: Map<string, boolean>,
 *   surfaces: Map<string, RawElementSurface>,
 *   definitions: RawDefinition[],
 *   globals: Map<string, string>,
 *   storage: Array<{ name: string, line: number }>,
 *   dynamic: Array<{ severity: 'error' | 'note', message: string }>,
 * }} ParsedModule
 */

/** Browser storage a module may not reach for on its own. See `storage` above. */
const WEB_STORAGE = new Set(['localStorage', 'sessionStorage']);

/** @type {Map<string, { size: number, mtimeMs: number, parsed: ParsedModule }>} */
const cache = new Map();

/**
 * Parse one module, or return the parse from last time if the file has not changed.
 *
 * `prefixes` participates in the cache key only through the resolved import targets, and
 * those are stable for a repository: the same file parsed for example1 and for example2
 * resolves `@core/` to the same directory. `@app/` is the exception and is why the key
 * includes it.
 *
 * @param {string} file Absolute path.
 * @param {Record<string, string>} prefixes Import-map prefix -> absolute directory.
 * @returns {Promise<ParsedModule>}
 */
export async function parseModule(file, prefixes) {
  const path = resolve(file);
  const key = `${path}\0${JSON.stringify(prefixes)}`;
  const stats = await stat(path);
  const cached = cache.get(key);
  if (cached !== undefined && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) {
    return cached.parsed;
  }

  const parsed = read(path, await readText(path), prefixes);
  cache.set(key, { size: stats.size, mtimeMs: stats.mtimeMs, parsed });
  return parsed;
}

/** Forget every parse. For a test that rewrites a fixture within one mtime tick. */
export function clearParseCache() {
  cache.clear();
}

/**
 * @param {string} path
 * @param {string} source
 * @param {Record<string, string>} prefixes
 * @returns {ParsedModule}
 */
function read(path, source, prefixes) {
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

  /** @type {ParsedModule} */
  const parsed = {
    path,
    imports: new Map(),
    importNames: new Map(),
    sideEffectImports: new Set(),
    classes: new Map(),
    surfaces: new Map(),
    definitions: [],
    globals: new Map(),
    storage: [],
    dynamic: [],
  };

  for (const statement of tree.statements) {
    if (ts.isClassDeclaration(statement) && statement.name !== undefined) {
      parsed.classes.set(statement.name.text, hasModifier(statement, ts.SyntaxKind.ExportKeyword));
      parsed.surfaces.set(statement.name.text, elementSurface(statement, tree));
      continue;
    }
    if (ts.isImportDeclaration(statement)) {
      const target = resolveSpecifier(statement.moduleSpecifier, path, prefixes);
      if (target === undefined) continue;

      // `import './md-body.js'` — no clause at all, and the import is the whole
      // point of the statement: running the module is what calls
      // `customElements.define`, and so what makes the element exist. Recorded
      // separately because for a plain custom element it is the only declaration
      // there is: `uses` takes component definitions and throws on a class that
      // has none, so such an element can never appear in one.
      if (statement.importClause === undefined) {
        parsed.sideEffectImports.add(target);
        continue;
      }

      const bindings = statement.importClause.namedBindings;
      if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
      for (const element of bindings.elements) {
        parsed.imports.set(element.name.text, target);
        parsed.importNames.set(element.name.text, element.propertyName?.text ?? element.name.text);
      }
    }
  }

  /** @param {ts.Node} node @returns {void} */
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callName = calledName(node.expression);
      if (callName === 'defineComponent') readDefineComponent(node, parsed, tree);
      else if (callName === 'customElements.define') readCustomElementsDefine(node, parsed, tree);
      else if (callName === 'registerTemplateGlobals') readGlobals(node, parsed);
    }
    // An identifier and not a text match, because every module that explains why it does
    // *not* reach for localStorage writes the word in a comment, and `globalThis.localStorage`
    // has to count while `'localStorage'` inside a message must not.
    if (ts.isIdentifier(node) && WEB_STORAGE.has(node.text)) {
      const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree));
      parsed.storage.push({ name: node.text, line: line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);

  return parsed;
}

/**
 * @param {ts.CallExpression} node
 * @param {ParsedModule} parsed
 * @param {ts.SourceFile} tree
 */
function readDefineComponent(node, parsed, tree) {
  const argument = node.arguments[0];
  if (argument === undefined || !ts.isObjectLiteralExpression(argument)) {
    parsed.dynamic.push({
      severity: 'error',
      message:
        `${at(tree, node)}: defineComponent() is called with ${
          argument === undefined ? 'no argument' : 'something other than an object literal'
        }, so no tool can tell which tag it defines.`,
    });
    return;
  }

  /** @type {string | undefined} */
  let tag;
  /** @type {string | undefined} */
  let className;
  /** @type {string | undefined} */
  let template;
  let templateDeclared = false;
  let templateLiteral = true;
  /** @type {string[]} */
  const uses = [];
  /** @type {string[]} */
  const unreadable = [];

  for (const property of argument.properties) {
    if (!ts.isPropertyAssignment(property)) {
      // A spread or a shorthand: whatever it contributes is not visible here.
      unreadable.push('a property that is not a plain `name: value` assignment');
      continue;
    }
    const name = propertyName(property.name);
    const value = property.initializer;
    if (name === 'tag') {
      if (ts.isStringLiteralLike(value)) tag = value.text.toLowerCase();
      else unreadable.push('a computed `tag`');
    } else if (name === 'element') {
      if (ts.isIdentifier(value)) className = value.text;
      else unreadable.push('an `element` that is not a class identifier');
    } else if (name === 'template') {
      templateDeclared = true;
      if (ts.isStringLiteralLike(value)) template = value.text;
      else if (value.kind !== ts.SyntaxKind.FalseKeyword) {
        templateLiteral = false;
        unreadable.push('a computed `template`');
      }
    } else if (name === 'uses') {
      if (ts.isArrayLiteralExpression(value)) {
        for (const entry of value.elements) {
          if (ts.isIdentifier(entry)) uses.push(entry.text);
          else unreadable.push('a `uses` entry that is not a class identifier');
        }
      } else unreadable.push('a `uses` that is not an array literal');
    }
  }

  if (tag === undefined || className === undefined || !templateLiteral || unreadable.length > 0) {
    parsed.dynamic.push({
      severity: 'error',
      message:
        `${at(tree, node)}: defineComponent(${tag === undefined ? '' : `"${tag}"`}) declares ${
          unreadable.length > 0 ? unreadable.join(', ') : 'no literal tag or element class'
        }. Static discovery cannot see it, so the template checker, the verifier and the ` +
          'template bundler cannot either.',
    });
    if (tag === undefined || className === undefined) return;
  }

  parsed.definitions.push({
    kind: 'defineComponent',
    className,
    tag,
    template,
    templateDeclared,
    uses,
  });
}

/**
 * A bare registration: a test fixture, or a class this repository does not own. Read
 * because the checker still has to know the tag exists, but it carries no template and
 * no `uses`.
 *
 * A computed one is a note rather than an error, and the reason is that this *is* the
 * mechanism: `defineComponent` itself ends in `customElements.define(tag, element)`, the
 * projection marker registers itself the same way, and a remote registers a class it was
 * handed. None of them has a template or a `uses` list for a static tool to lose.
 *
 * @param {ts.CallExpression} node
 * @param {ParsedModule} parsed
 * @param {ts.SourceFile} tree
 */
function readCustomElementsDefine(node, parsed, tree) {
  const tagArgument = node.arguments[0];
  const classArgument = node.arguments[1];
  if (
    tagArgument === undefined ||
    !ts.isStringLiteralLike(tagArgument) ||
    classArgument === undefined ||
    !ts.isIdentifier(classArgument)
  ) {
    parsed.dynamic.push({
      severity: 'note',
      message:
        `${at(tree, node)}: customElements.define() is called with a computed tag or class, so ` +
        'no tool can name the element it registers.',
    });
    return;
  }

  parsed.definitions.push({
    kind: 'customElements.define',
    className: classArgument.text,
    tag: tagArgument.text.toLowerCase(),
    template: undefined,
    templateDeclared: false,
    uses: [],
  });
}

/**
 * @param {ts.CallExpression} node
 * @param {ParsedModule} parsed
 */
function readGlobals(node, parsed) {
  const object = node.arguments[0];
  if (object === undefined || !ts.isObjectLiteralExpression(object)) return;
  for (const property of object.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      parsed.globals.set(property.name.text, property.name.text);
    } else if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer)) {
      const name = propertyName(property.name);
      if (name !== undefined) parsed.globals.set(name, property.initializer.text);
    }
  }
}

/**
 * One class's authored Element meaning. Cross-module inheritance is resolved only after
 * every module is parsed, in index.mjs.
 *
 * Two declarations produce it, and an element may use either. `static properties` is
 * Lit's, and it names *properties*; the attribute each one observes is `attribute: 'x'`
 * when written, nothing when `attribute: false` or `state: true`, and otherwise the
 * property name lowercased — `ReactiveElement`'s own rule, which is why `emptyLabel`
 * answers to `emptylabel` and never to `empty-label`. `static observedAttributes` is the
 * platform's, used here by elements that are configuration rather than components
 * (`<ui-table-column>`), and it names attributes directly.
 *
 * `attributes: null` means the declaration exists but cannot be read — a spread, a
 * computed options object, a name from a constant. Null is not the same as empty: no tool
 * may conclude an attribute is dead from a surface it could not read.
 *
 * The instance members are read too, and for one question only: whether a field covers a
 * method of the same name. A field is installed with [[Define]], so it hides the method
 * rather than overriding it, and the call that reaches the field's value fails far from
 * the line that declared it. index.mjs resolves that across inheritance. ADR-0115.
 *
 * @param {ts.ClassDeclaration} declaration
 * @param {ts.SourceFile} tree
 * @returns {RawElementSurface}
 */
function elementSurface(declaration, tree) {
  /** @type {RawProperty[]} */
  const properties = [];
  let propertiesKnown = true;
  /** @type {string[]} */
  const observedAttributes = [];
  let attributesDeclared = false;
  let attributesIncludeSuper = false;
  let attributesKnown = true;
  /** @type {string[]} */
  const methods = [];
  /** @type {RawField[]} */
  const fields = [];

  const extension = declaration.heritageClauses
    ?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
    ?.types[0]?.expression;
  const superclass = extension !== undefined && ts.isIdentifier(extension) ? extension.text : null;
  const inheritanceKnown = extension === undefined || superclass !== null;

  for (const member of declaration.members) {
    if (!hasModifier(member, ts.SyntaxKind.StaticKeyword)) {
      readInstanceMember(member, tree, methods, fields);
      continue;
    }
    const declared = member.name === undefined ? undefined : propertyName(member.name);
    const value = staticValue(member);

    if (declared === 'properties') {
      if (value === undefined || !ts.isObjectLiteralExpression(value)) {
        propertiesKnown = false;
        attributesKnown = false;
        continue;
      }
      for (const property of value.properties) {
        if (ts.isSpreadAssignment(property) && isSuperProperty(property.expression, 'properties')) {
          continue;
        }
        if (!ts.isPropertyAssignment(property)) {
          propertiesKnown = false;
          attributesKnown = false;
          continue;
        }
        const name = propertyName(property.name);
        if (name === undefined) {
          propertiesKnown = false;
          attributesKnown = false;
          continue;
        }
        const meaning = propertyMeaning(name, property.initializer);
        const location = sourcePosition(tree, property.name);
        properties.push({ name, ...meaning, ...location });
        if (meaning.kind === 'unknown') propertiesKnown = false;
        if (meaning.attribute === null) attributesKnown = false;
      }
      continue;
    }

    if (declared === 'observedAttributes') {
      attributesDeclared = true;
      if (value === undefined || !ts.isArrayLiteralExpression(value)) {
        attributesKnown = false;
        continue;
      }
      for (const entry of value.elements) {
        if (ts.isSpreadElement(entry) && isSuperProperty(entry.expression, 'observedAttributes')) {
          attributesIncludeSuper = true;
          continue;
        }
        if (ts.isStringLiteralLike(entry)) observedAttributes.push(entry.text.toLowerCase());
        else attributesKnown = false;
      }
    }
  }

  const foundEvents = readEvents(declaration, tree);
  return {
    superclass,
    inheritanceKnown,
    methods,
    fields,
    properties,
    propertiesKnown,
    observedAttributes,
    attributesDeclared,
    attributesIncludeSuper,
    attributesKnown,
    events: foundEvents.events,
    eventsKnown: foundEvents.known,
  };
}

/**
 * One instance member, as either a method name or a field.
 *
 * Methods and fields only. A `get`/`set` pair is neither: it is not callable, so nothing
 * calls it, and a field over one is the reactive-property shape the runtime repairs.
 * Private and computed names are skipped — neither can be resolved across modules, and a
 * name no tool can spell is one no tool should report a collision for.
 *
 * @param {ts.ClassElement} member
 * @param {ts.SourceFile} tree
 * @param {string[]} methods
 * @param {RawField[]} fields
 */
function readInstanceMember(member, tree, methods, fields) {
  const name = member.name === undefined ? undefined : propertyName(member.name);
  if (name === undefined) return;

  if (ts.isMethodDeclaration(member)) {
    methods.push(name);
    return;
  }
  if (!ts.isPropertyDeclaration(member)) return;
  fields.push({
    name,
    callable: fieldCallability(member.initializer),
    ...sourcePosition(tree, member.name),
  });
}

/**
 * Whether a field's value is a function: true, false, or null when no static read can
 * say.
 *
 * Null is the answer for an identifier, a call or anything else whose value is decided
 * elsewhere, and it stays null. A field initialised from a constant that happens to hold a
 * function is a working component, and reporting it as broken would teach authors to
 * ignore the diagnostic.
 *
 * @param {ts.Expression | undefined} initializer
 * @returns {boolean | null}
 */
function fieldCallability(initializer) {
  // `render;` installs `undefined`, which hides a method exactly as a string does.
  if (initializer === undefined) return false;
  if (
    ts.isArrowFunction(initializer) ||
    ts.isFunctionExpression(initializer) ||
    ts.isClassExpression(initializer)
  ) {
    return true;
  }
  if (
    ts.isStringLiteralLike(initializer) ||
    ts.isNumericLiteral(initializer) ||
    ts.isObjectLiteralExpression(initializer) ||
    ts.isArrayLiteralExpression(initializer) ||
    ts.isTemplateExpression(initializer) ||
    ts.isNewExpression(initializer) ||
    initializer.kind === ts.SyntaxKind.TrueKeyword ||
    initializer.kind === ts.SyntaxKind.FalseKeyword ||
    initializer.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(initializer) && initializer.text === 'undefined')
  ) {
    return false;
  }
  return null;
}

/**
 * Meaning of one `static properties` entry. Unknown is kept as unknown: an options
 * object assembled elsewhere may contain `state: true`, so calling it public would leak
 * internal state through every consumer of the model.
 *
 * @param {string} property
 * @param {ts.Expression} options
 * @returns {{ kind: 'input' | 'state' | 'unknown', attribute: string | false | null }}
 */
function propertyMeaning(property, options) {
  if (
    ts.isIdentifier(options) &&
    ['Array', 'Boolean', 'Number', 'Object', 'String'].includes(options.text)
  ) {
    return { kind: 'input', attribute: property.toLowerCase() };
  }
  if (!ts.isObjectLiteralExpression(options)) return { kind: 'unknown', attribute: null };

  /** @type {'input' | 'state' | 'unknown'} */
  let kind = 'input';
  /** @type {string | false | null} */
  let attribute = property.toLowerCase();
  for (const option of options.properties) {
    if (!ts.isPropertyAssignment(option)) return { kind: 'unknown', attribute: null };
    const key = propertyName(option.name);
    const value = option.initializer;
    if (key === 'state') {
      if (value.kind === ts.SyntaxKind.TrueKeyword) kind = 'state';
      else if (value.kind !== ts.SyntaxKind.FalseKeyword) kind = 'unknown';
    } else if (key === 'attribute') {
      if (ts.isStringLiteralLike(value)) attribute = value.text.toLowerCase();
      else if (value.kind === ts.SyntaxKind.FalseKeyword) attribute = false;
      else if (value.kind !== ts.SyntaxKind.TrueKeyword) attribute = null;
    }
  }
  if (kind === 'state') attribute = false;
  if (kind === 'unknown') attribute = null;
  return { kind, attribute };
}

/** Static field initializer or a static getter's single returned expression. */
function staticValue(/** @type {ts.ClassElement} */ member) {
  if (ts.isPropertyDeclaration(member)) return member.initializer;
  if (!ts.isGetAccessorDeclaration(member) || member.body === undefined) return undefined;
  const returns = member.body.statements.filter(ts.isReturnStatement);
  return returns.length === 1 ? returns[0]?.expression : undefined;
}

/** @param {ts.Expression} expression @param {string} name */
function isSuperProperty(expression, name) {
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.expression.kind === ts.SyntaxKind.SuperKeyword &&
    expression.name.text === name
  );
}

/**
 * Events dispatched by instance code. Event names may be literals or a JSDoc literal
 * union on a helper parameter; anything else makes the set explicitly incomplete.
 *
 * @param {ts.ClassDeclaration} declaration
 * @param {ts.SourceFile} tree
 */
function readEvents(declaration, tree) {
  /** @type {RawEvent[]} */
  const events = [];
  let known = true;

  /** @param {ts.Node} node */
  const visit = (node) => {
    if (node !== declaration && ts.isClassLike(node)) return;
    if (
      ts.isCallExpression(node) &&
      calledName(node.expression) === 'this.dispatchEvent'
    ) {
      const created = node.arguments[0];
      if (
        created !== undefined &&
        ts.isNewExpression(created) &&
        ts.isIdentifier(created.expression) &&
        (created.expression.text === 'CustomEvent' || created.expression.text === 'Event')
      ) {
        const nameNode = created.arguments?.[0];
        const names = nameNode === undefined ? [] : eventNames(nameNode);
        if (names.length === 0) known = false;
        const detail =
          created.expression.text === 'CustomEvent'
            ? eventDetail(created.arguments?.[1])
            : { kind: /** @type {const} */ ('none') };
        const location = sourcePosition(tree, nameNode ?? created);
        for (const name of names) {
          events.push({
            name,
            event: created.expression.text,
            detail,
            ...location,
          });
        }
      } else known = false;
    }
    ts.forEachChild(node, visit);
  };
  for (const member of declaration.members) {
    if (!hasModifier(member, ts.SyntaxKind.StaticKeyword)) visit(member);
  }
  return { events, known };
}

/** @param {ts.Expression} node @returns {string[]} */
function eventNames(node) {
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isConditionalExpression(node)) {
    return [...eventNames(node.whenTrue), ...eventNames(node.whenFalse)];
  }
  if (!ts.isIdentifier(node)) return [];
  const parameter = enclosingParameter(node, node.text);
  const type = parameter === undefined ? undefined : ts.getJSDocType(parameter);
  return type === undefined ? [] : literalStrings(type);
}

/** @param {ts.TypeNode} type @returns {string[]} */
function literalStrings(type) {
  if (ts.isUnionTypeNode(type)) return type.types.flatMap(literalStrings);
  if (ts.isLiteralTypeNode(type) && ts.isStringLiteralLike(type.literal)) {
    return [type.literal.text];
  }
  return [];
}

/** @param {ts.Expression | undefined} options */
function eventDetail(options) {
  if (options === undefined) {
    return { kind: /** @type {const} */ ('none') };
  }
  if (!ts.isObjectLiteralExpression(options)) return { kind: /** @type {const} */ ('unknown') };
  const assigned = options.properties.find(
    (property) => ts.isPropertyAssignment(property) && propertyName(property.name) === 'detail',
  );
  if (assigned === undefined || !ts.isPropertyAssignment(assigned)) {
    return { kind: /** @type {const} */ ('none') };
  }
  const value = assigned.initializer;
  if (
    ts.isPropertyAccessExpression(value) &&
    value.expression.kind === ts.SyntaxKind.ThisKeyword &&
    ts.isIdentifier(value.name)
  ) {
    return { kind: /** @type {const} */ ('property'), name: value.name.text };
  }
  if (ts.isObjectLiteralExpression(value)) {
    const properties = value.properties.flatMap((property) => {
      if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
        const name = propertyName(property.name);
        return name === undefined ? [] : [name];
      }
      return [];
    });
    return properties.length === value.properties.length
      ? { kind: /** @type {const} */ ('object'), properties: [...new Set(properties)].sort() }
      : { kind: /** @type {const} */ ('unknown') };
  }
  const primitive = primitiveType(value);
  if (primitive !== undefined) return { kind: /** @type {const} */ ('type'), text: primitive };
  if (ts.isIdentifier(value)) {
    const parameter = enclosingParameter(value, value.text);
    const type = parameter === undefined ? undefined : ts.getJSDocType(parameter);
    const text = type === undefined ? undefined : portableType(type);
    if (text !== undefined) return { kind: /** @type {const} */ ('type'), text };
  }
  return { kind: /** @type {const} */ ('unknown') };
}

/** @param {ts.Expression} value */
function primitiveType(value) {
  if (ts.isStringLiteralLike(value)) return 'string';
  if (ts.isNumericLiteral(value)) return 'number';
  if (value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword) {
    return 'boolean';
  }
  if (value.kind === ts.SyntaxKind.NullKeyword) return 'null';
  if (ts.isIdentifier(value) && value.text === 'undefined') return 'undefined';
  return undefined;
}

/** Portable primitive JSDoc type safe to emit in a generated module. @returns {string | undefined} */
function portableType(/** @type {ts.TypeNode} */ type) {
  if (ts.isUnionTypeNode(type)) {
    const parts = type.types.map(portableType);
    return parts.every((part) => part !== undefined) ? parts.join(' | ') : undefined;
  }
  if (ts.isParenthesizedTypeNode(type)) {
    const inside = portableType(type.type);
    return inside === undefined ? undefined : `(${inside})`;
  }
  if (ts.isArrayTypeNode(type)) {
    const item = portableType(type.elementType);
    return item === undefined ? undefined : `Array<${item}>`;
  }
  if (ts.isLiteralTypeNode(type)) {
    if (ts.isStringLiteralLike(type.literal)) return JSON.stringify(type.literal.text);
    if (ts.isNumericLiteral(type.literal)) return type.literal.text;
    if (type.literal.kind === ts.SyntaxKind.TrueKeyword) return 'true';
    if (type.literal.kind === ts.SyntaxKind.FalseKeyword) return 'false';
    if (type.literal.kind === ts.SyntaxKind.NullKeyword) return 'null';
  }
  const keywords = new Map([
    [ts.SyntaxKind.StringKeyword, 'string'],
    [ts.SyntaxKind.NumberKeyword, 'number'],
    [ts.SyntaxKind.BooleanKeyword, 'boolean'],
    [ts.SyntaxKind.UndefinedKeyword, 'undefined'],
    [ts.SyntaxKind.UnknownKeyword, 'unknown'],
  ]);
  return keywords.get(type.kind);
}

/** @param {ts.Node} node @param {string} name */
function enclosingParameter(node, name) {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (!ts.isFunctionLike(current)) continue;
    return current.parameters.find(
      (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === name,
    );
  }
  return undefined;
}

/** @param {ts.SourceFile} tree @param {ts.Node} node */
function sourcePosition(tree, node) {
  const start = node.getStart(tree) + (ts.isStringLiteralLike(node) ? 1 : 0);
  const { line, character } = tree.getLineAndCharacterOfPosition(start);
  return { line: line + 1, column: character + 1 };
}

/**
 * Turn an import specifier into the file it names, for the prefixes an application's
 * import map declares. A bare specifier — `lit` — names nothing in this repository.
 *
 * @param {ts.Expression} specifier
 * @param {string} file
 * @param {Record<string, string>} prefixes
 * @returns {string | undefined}
 */
function resolveSpecifier(specifier, file, prefixes) {
  if (!ts.isStringLiteralLike(specifier)) return undefined;
  const text = specifier.text;
  if (text.startsWith('.')) return resolve(dirname(file), text);
  for (const [prefix, directory] of Object.entries(prefixes)) {
    if (text.startsWith(prefix)) return resolve(directory, text.slice(prefix.length));
  }
  return undefined;
}

/**
 * `path:line:column`, so a diagnostic about a declaration names the declaration.
 *
 * @param {ts.SourceFile} tree
 * @param {ts.Node} node
 * @returns {string}
 */
function at(tree, node) {
  const { line, character } = tree.getLineAndCharacterOfPosition(node.getStart(tree));
  return `${tree.fileName}:${String(line + 1)}:${String(character + 1)}`;
}

/**
 * @param {ts.Node} node
 * @param {ts.SyntaxKind} kind
 * @returns {boolean}
 */
function hasModifier(node, kind) {
  if (!ts.canHaveModifiers(node)) return false;
  return ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false;
}

/**
 * @param {ts.PropertyName} name
 * @returns {string | undefined}
 */
function propertyName(name) {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;
}

/**
 * @param {ts.Expression} expression
 * @returns {string | undefined}
 */
function calledName(expression) {
  if (expression.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    const left = calledName(expression.expression);
    return left === undefined ? expression.name.text : `${left}.${expression.name.text}`;
  }
  return undefined;
}
