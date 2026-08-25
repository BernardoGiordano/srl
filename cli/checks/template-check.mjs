/**
 * Static type checking for the HTML template DSL.
 *
 * No shim is written to disk. Each component template becomes a virtual
 * TypeScript file beside its component module, and the ordinary compiler API
 * checks that file against the same tsconfig and JSDoc types as the JavaScript.
 * Expressions are parsed by source/lib/core/template/expression-parser.js, and the
 * dialect itself — the attribute tables, the directive syntax, the sink/security
 * map — comes from source/lib/core/template/dialect.js. Both are shared with the runtime
 * evaluator, so this tool is an emitter for one grammar rather than a second
 * copy of it. Anything this file states about the dialect on its own is a
 * divergence waiting to happen.
 */

import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import {
  camelCase,
  classifyAttributeName,
  classifyBindingTarget,
  FOR_HEAD,
  FOR_INDEX_CLAUSE,
  FOR_KEY_CLAUSE,
  INTERPOLATION,
  refusedProperty,
  securityContextFor,
  strictOperator,
  VOID_ELEMENTS,
} from '@srljs/core/lib/core/template/dialect.js';
import { parseExpression } from '@srljs/core/lib/core/template/expression-parser.js';
import { apps, REPO } from '../layout.mjs';
import { readProject } from '../project-model/index.mjs';

const HTML_ELEMENTS = new Set(
  `a abbr address area article aside audio b base bdi bdo blockquote body br button canvas
   caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em embed
   fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe
   img input ins kbd label legend li link main map mark menu meta meter nav noscript object ol
   optgroup option output p picture pre progress q rp rt ruby s samp script search section select
   slot small source span strong style sub summary sup table tbody td template textarea tfoot th
   thead time title tr track u ul var video wbr`.split(/\s+/u),
);

const SVG_ELEMENTS = new Set(
  `svg animate animateMotion animateTransform circle clipPath defs desc ellipse feBlend
   feColorMatrix feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting
   feDisplacementMap feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR
   feGaussianBlur feImage feMerge feMergeNode feMorphology feOffset fePointLight
   feSpecularLighting feSpotLight feTile feTurbulence filter foreignObject g image line
   linearGradient marker mask metadata mpath path pattern polygon polyline radialGradient rect
   set stop switch symbol text textPath tspan use view`.split(/\s+/u).map((tag) => tag.toLowerCase()),
);

const MATHML_ELEMENTS = new Set(
  `math maction annotation annotation-xml menclose merror mfenced mfrac mi mmultiscripts mn mo
   mover mpadded mphantom mprescripts mroot mrow ms mspace msqrt mstyle msub msubsup msup mtable
   mtd mtext mtr munder munderover semantics`.split(/\s+/u),
);

/** @typedef {{ name: string, value: string, at: number }} Attribute */
/** @typedef {{ kind: 'text', value: string, at: number } | ElementNode} TemplateNode */
/** @typedef {{ kind: 'element', tag: string, attributes: Attribute[], children: TemplateNode[], at: number }} ElementNode */
/** @typedef {{ source: string, at: number }} BindingSource */
/** @typedef {{ start: number, end: number, template: string, at: number }} SourceMapEntry */
/**
 * Attributes any element may carry: HTML's global content attributes, plus `role`.
 *
 * `aria-*` and `data-*` are handled by prefix. `part` and `exportparts` are deliberately
 * absent — every component here renders into light DOM, so a part name addresses nothing
 * and a dead one should be reported like any other.
 *
 * This is a statement about HTML rather than about the dialect, which is why it lives here
 * and not in `dialect.js`: the runtime never validates an attribute name, so shipping the
 * table to the browser would be bytes no evaluator reads.
 */
const GLOBAL_ATTRIBUTES = new Set(
  `accesskey autocapitalize autocorrect autofocus class contenteditable dir draggable
   enterkeyhint hidden id inert inputmode is itemid itemprop itemref itemscope itemtype lang
   nonce popover role slot spellcheck style tabindex title translate
   writingsuggestions`.split(/\s+/u),
);

/** @typedef {{
 *   module: string,
 *   className: string,
 *   exported: boolean,
 *   properties?: readonly string[],
 *   observedAttributes?: readonly string[] | null,
 * }} ElementType */
/** @typedef {{ module: string, className: string, template: string, available: Set<string> }} Component */
/** @typedef {{ name: string, dir: string }} Application */
/** @typedef {{ module: string, exportName: string }} TemplateGlobal */

/**
 * Tags every template may name without declaring anything, and the attributes each one
 * takes.
 *
 * Only `<x-content>`, and it is not a component: it is the projection marker the
 * dialect itself defines, the way `*if` is part of the dialect. Every real
 * element — including `<x-outlet>` and `<x-route-outlet>` — has a definition and
 * has to be imported by the component whose markup names it.
 *
 * `name` is the bucket a marker projects, read with `getAttribute` in projection.js rather
 * than declared as a reactive property, so the project model cannot know about it and this
 * is the one place that can.
 */
const INTRINSIC_ELEMENTS = new Map([['x-content', ['name']]]);

class GeneratedFile {
  text = '';
  /** @type {SourceMapEntry[]} */
  mappings = [];

  /** @param {string} value */
  write(value) {
    this.text += value;
  }

  /** @param {string} value @param {string} template @param {number} at */
  mapped(value, template, at) {
    const start = this.text.length;
    this.text += value;
    this.mappings.push({ start, end: this.text.length, template, at });
  }
}

/** Parse enough HTML to retain element scope and exact binding offsets.
 * @param {string} source @param {string} where @returns {TemplateNode[]}
 */
export function parseTemplate(source, where) {
  /** @type {TemplateNode[]} */
  const roots = [];
  /** @type {{ tag: string, children: TemplateNode[] }[]} */
  const stack = [{ tag: '', children: roots }];
  let index = 0;

  while (index < source.length) {
    if (source.startsWith('<!--', index)) {
      const end = source.indexOf('-->', index + 4);
      index = end === -1 ? source.length : end + 3;
      continue;
    }

    if (source[index] !== '<') {
      const stop = textEnd(source, index);
      stack.at(-1)?.children.push({ kind: 'text', value: source.slice(index, stop), at: index });
      index = stop;
      continue;
    }

    if (source.startsWith('</', index)) {
      const close = /^<\/\s*([A-Za-z][\w:-]*)[^>]*>/u.exec(source.slice(index));
      if (close === null) {
        index += 1;
        continue;
      }
      const tag = (close[1] ?? '').toLowerCase();
      while (stack.length > 1) {
        const open = stack.pop();
        if (open?.tag === tag) break;
      }
      index += close[0].length;
      continue;
    }

    if (source.startsWith('<!', index) || source.startsWith('<?', index)) {
      const end = source.indexOf('>', index + 2);
      index = end === -1 ? source.length : end + 1;
      continue;
    }

    const end = tagEnd(source, index + 1);
    if (end === -1) throw new Error(`${where}: unterminated start tag`);
    const inside = source.slice(index + 1, end);
    const head = /^\s*([A-Za-z][\w:-]*)/u.exec(inside);
    if (head === null) {
      index += 1;
      continue;
    }

    const tag = (head[1] ?? '').toLowerCase();
    const node = {
      kind: /** @type {const} */ ('element'),
      tag,
      attributes: parseAttributes(inside, index + 1, head[0].length),
      children: [],
      at: index,
    };
    stack.at(-1)?.children.push(node);

    const selfClosing = /\/\s*$/u.test(inside);
    if (!selfClosing && !VOID_ELEMENTS.has(tag)) stack.push({ tag, children: node.children });
    index = end + 1;
  }

  return roots;
}

/** Skip interpolation bodies so a comparison such as `a < b` is not an HTML tag.
 * @param {string} source @param {number} from @returns {number}
 */
function textEnd(source, from) {
  let index = from;
  while (index < source.length) {
    if (source.startsWith('{{', index)) {
      const close = source.indexOf('}}', index + 2);
      index = close === -1 ? source.length : close + 2;
    } else if (source[index] === '<') return index;
    else index += 1;
  }
  return source.length;
}

/** @param {string} source @param {number} from */
function tagEnd(source, from) {
  /** @type {string | undefined} */
  let quote;
  for (let index = from; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '>') return index;
  }
  return -1;
}

/** @param {string} source @param {number} absolute @param {number} from */
function parseAttributes(source, absolute, from) {
  /** @type {Attribute[]} */
  const attributes = [];
  let index = from;
  while (index < source.length) {
    while (/\s/u.test(source[index] ?? '')) index += 1;
    if (source[index] === '/' || index >= source.length) break;
    const nameMatch = /^[^\s=/>]+/u.exec(source.slice(index));
    if (nameMatch === null) {
      index += 1;
      continue;
    }
    const name = nameMatch[0].toLowerCase();
    const nameAt = absolute + index;
    index += name.length;
    while (/\s/u.test(source[index] ?? '')) index += 1;
    if (source[index] !== '=') {
      attributes.push({ name, value: '', at: nameAt });
      continue;
    }
    index += 1;
    while (/\s/u.test(source[index] ?? '')) index += 1;
    const quote = source[index];
    if (quote === '"' || quote === "'") {
      index += 1;
      const valueAt = absolute + index;
      const end = source.indexOf(quote, index);
      const stop = end === -1 ? source.length : end;
      attributes.push({ name, value: source.slice(index, stop), at: valueAt });
      index = end === -1 ? source.length : end + 1;
    } else {
      const valueAt = absolute + index;
      const valueMatch = /^[^\s>]+/u.exec(source.slice(index));
      const value = valueMatch?.[0] ?? '';
      attributes.push({ name, value, at: valueAt });
      index += value.length;
    }
  }
  return attributes;
}

/**
 * The project's own view of its components, in the shape the shim builder needs.
 *
 * Discovery is not this tool's job any more: `cli/project-model/` reads
 * `defineComponent({ tag, element, module, template, uses })` — the same record
 * `@core/elements/component.js` builds at runtime — and the checker asks it which elements exist.
 * That is what keeps the checker from having its own opinion about the project, and it is
 * why a definition the model cannot read is a verification failure rather than an element
 * this tool silently does not know about.
 *
 * The one thing added here is the dialect's own intrinsic: `<x-content>` is a projection
 * marker rather than a component, so it belongs to the language and not to the model.
 *
 * @param {Application} app
 * @returns {Promise<{ components: Component[], elements: Map<string, ElementType>, globals: Map<string, TemplateGlobal> }>}
 */
async function discover(app) {
  const model = await readProject(app);

  /** @type {Map<string, ElementType>} */
  const elements = new Map();
  for (const record of model.elements.values()) {
    elements.set(record.tag, {
      module: record.module,
      className: record.className,
      exported: record.exported,
      properties: record.properties,
      observedAttributes: record.observedAttributes,
    });
  }

  /** @type {Component[]} */
  const components = [];
  for (const record of model.elements.values()) {
    if (record.template === null) continue;
    components.push({
      module: record.module,
      className: record.className,
      template: record.template,
      available: new Set([...INTRINSIC_ELEMENTS.keys(), ...record.usesTags]),
    });
  }

  return { components, elements, globals: model.globals };
}

class ShimBuilder {
  /** @type {GeneratedFile} */ file;
  /** @type {Map<string, string>} */ hostNames = new Map();
  /** @type {Map<string, number>} */ hostOffsets = new Map();
  /** @type {{ at: number, message: string }[]} */ problems = [];
  counter = 0;

  /**
   * @param {Component} component
   * @param {TemplateNode[]} tree
   * @param {Map<string, ElementType>} elements
   * @param {Map<string, TemplateGlobal>} globals
   */
  constructor(component, tree, elements, globals) {
    this.component = component;
    this.tree = tree;
    this.elements = elements;
    this.globals = globals;
    this.available = component.available;
    this.file = new GeneratedFile();
  }

  build() {
    const body = new GeneratedFile();
    this.file = body;
    this.nodes(this.tree, new Map(), 1);

    const output = new GeneratedFile();
    const componentSpecifier = moduleSpecifier(this.component.module, this.component.module);
    output.write(`type __Host = InstanceType<typeof import(${JSON.stringify(componentSpecifier)})[${JSON.stringify(this.component.className)}]>;\n`);
    output.write('type __Unwrap<T> = T extends import("@core/foundation/types.js").ReadonlySignal<infer V> ? V : T;\n');
    output.write('declare function __unwrap<T>(value: T): __Unwrap<T>;\n');
    output.write('declare function __iter<T>(value: Iterable<T> | null | undefined): Iterable<T>;\n');
    output.write('declare function __assign<T>(target: T, value: __Unwrap<T>): __Unwrap<T>;\n');
    output.write('declare function __boolean(value: boolean): void;\n');
    output.write('declare function __htmlSink(value: string | import("@core/template/types.js").TrustedHtml | null | undefined): void;\n');
    output.write('declare function __styleSink(value: string | import("@core/template/types.js").TrustedStyle | null | undefined): void;\n');
    output.write('declare function __urlSink(value: string | URL | import("@core/template/types.js").TrustedUrl | null | undefined): void;\n');
    output.write('declare function __urlSetSink(value: string | import("@core/template/types.js").TrustedUrl | null | undefined): void;\n');
    output.write('declare function __resourceUrlSink(value: import("@core/template/types.js").TrustedResourceUrl | null | undefined): void;\n');
    output.write('type __Event<N extends string> = N extends keyof HTMLElementEventMap ? HTMLElementEventMap[N] : Event;\n');
    output.write('type __TemplateEvent<E extends EventTarget, N extends string> = __Event<N> & { readonly target: E; readonly currentTarget: E };\n');
    output.write('export {};\n');

    for (const [name, global] of this.globals) {
      const id = globalIdentifier(name);
      output.write(
        `declare const ${id}: typeof import(${JSON.stringify(moduleSpecifier(this.component.module, global.module))})[${JSON.stringify(global.exportName)}];\n`,
      );
    }

    output.write('function __check(__host: __Host): void {\n');
    for (const [name, id] of this.hostNames) {
      const start = output.text.length;
      const declaration = `  const ${id} = __unwrap(__host[${JSON.stringify(name)}]);\n`;
      output.write(declaration);
      output.mappings.push({
        start,
        end: output.text.length,
        template: this.component.template,
        at: this.hostOffsets.get(name) ?? 0,
      });
    }
    const bodyStart = output.text.length;
    output.write(body.text);
    for (const mapping of body.mappings) {
      output.mappings.push({ ...mapping, start: mapping.start + bodyStart, end: mapping.end + bodyStart });
    }
    output.write('}\nvoid __check;\n');
    return output;
  }

  /** @param {TemplateNode[]} nodes @param {Map<string, string>} scope @param {number} indent */
  nodes(nodes, scope, indent) {
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      if (node === undefined) continue;
      if (node.kind === 'text') {
        this.interpolations(node.value, node.at, scope, indent);
        continue;
      }
      const condition = attribute(node, '*if');
      let alternateIndex = index + 1;
      let possibleAlternate = nodes[alternateIndex];
      while (possibleAlternate?.kind === 'text' && possibleAlternate.value.trim() === '') {
        alternateIndex += 1;
        possibleAlternate = nodes[alternateIndex];
      }
      const next = possibleAlternate;
      const alternate = next?.kind === 'element' && attribute(next, '*else') !== undefined ? next : undefined;
      if (condition !== undefined && attribute(node, '*for') !== undefined) {
        // The runtime refuses this outright (template.js), rather than picking an
        // order. Silently checking only the *if was the checker's oldest lie.
        this.problem(
          node.at,
          `${this.component.template}: <${node.tag}> carries both *for and *if. ` +
            `Wrap one in an element of its own.`,
        );
        continue;
      }
      if (condition !== undefined) {
        this.line(indent, 'if (');
        this.expression(condition, scope, false);
        this.file.write(') {\n');
        this.elementBody(node, scope, indent + 1, new Set(['*if']));
        this.line(indent, '}');
        if (alternate !== undefined) {
          this.file.write(' else {\n');
          this.elementBody(alternate, scope, indent + 1, new Set(['*else']));
          this.line(indent, '}\n');
          index = alternateIndex;
        } else this.file.write('\n');
        continue;
      }
      if (attribute(node, '*else') !== undefined) {
        this.problem(node.at, `${this.component.template}: *else has no preceding *if`);
        continue;
      }
      this.element(node, scope, indent);
    }
  }

  /** @param {ElementNode} node @param {Map<string, string>} scope @param {number} indent */
  element(node, scope, indent) {
    const loop = attribute(node, '*for');
    if (loop === undefined) {
      this.elementBody(node, scope, indent, new Set());
      return;
    }

    const [head = '', ...clauses] = loop.value.split(';');
    const parsed = FOR_HEAD.exec(head);
    if (parsed === null) {
      this.problem(loop.at, `${this.component.template}: invalid *for expression ${JSON.stringify(loop.value)}`);
      return;
    }
    const alias = parsed[1] ?? '';
    const list = { source: parsed[2] ?? '', at: loop.at + loop.value.indexOf(parsed[2] ?? '') };
    const itemId = this.id('item');
    this.line(indent, `for (const ${itemId} of __iter(`);
    this.expression(list, scope, false);
    this.file.write(')) {\n');

    const child = new Map(scope);
    child.set(alias, itemId);
    const indexId = this.id('index');
    const firstId = this.id('first');
    const lastId = this.id('last');
    const countId = this.id('count');
    child.set('$index', indexId);
    child.set('$first', firstId);
    child.set('$last', lastId);
    child.set('$count', countId);
    this.line(indent + 1, `const ${indexId}: number = 0;\n`);
    this.line(indent + 1, `const ${firstId}: boolean = false;\n`);
    this.line(indent + 1, `const ${lastId}: boolean = false;\n`);
    this.line(indent + 1, `const ${countId}: number = 0;\n`);

    for (const clause of clauses) {
      const trimmed = clause.trim();
      if (trimmed === '') continue;
      const key = FOR_KEY_CLAUSE.exec(trimmed)?.[1];
      if (key !== undefined) {
        const at = loop.at + loop.value.indexOf(key);
        this.line(indent + 1, 'void (');
        this.expression({ source: key, at }, child, false);
        this.file.write(');\n');
        continue;
      }
      const indexAlias = FOR_INDEX_CLAUSE.exec(trimmed)?.[1];
      if (indexAlias !== undefined) {
        child.set(indexAlias, indexId);
        continue;
      }
      this.problem(loop.at, `${this.component.template}: invalid *for clause ${JSON.stringify(trimmed)}`);
    }

    this.elementBody(node, child, indent + 1, new Set(['*for']));
    this.line(indent, '}\n');
  }

  /** @param {ElementNode} node @param {Map<string, string>} scope @param {number} indent @param {Set<string>} skip */
  elementBody(node, scope, indent, skip) {
    this.checkTag(node);
    for (const attr of node.attributes) {
      if (skip.has(attr.name)) continue;
      const syntax = classifyAttributeName(attr.name);
      if (syntax.kind === 'inline-handler') {
        this.problem(
          attr.at,
          `${this.component.template}: inline event handler attribute ${attr.name} is forbidden. ` +
            `Use (${syntax.event})="handler()".`,
        );
        continue;
      }
      if (syntax.kind === 'event') {
        const { event } = syntax;
        const eventId = this.id('event');
        const elementType = this.elementType(node.tag);
        this.line(
          indent,
          `const ${eventId} = null as unknown as __TemplateEvent<${elementType}, ${JSON.stringify(event)}>;\n`,
        );
        const child = new Map(scope);
        child.set('$event', eventId);
        this.line(indent, 'void (');
        this.expression({ source: attr.value, at: attr.at }, child, true);
        this.file.write(');\n');
        continue;
      }
      if (syntax.kind === 'binding') {
        const classified = classifyBindingTarget(syntax.target);
        const { name } = classified;
        if (classified.kind === 'inline-handler') {
          this.problem(
            attr.at,
            `${this.component.template}: inline event attribute ${syntax.target} is forbidden`,
          );
        } else if (classified.kind === 'empty-attribute' || classified.kind === 'empty-property') {
          this.problem(attr.at, `${this.component.template}: empty ${attr.name} binding`);
        } else if (classified.kind === 'boolean') {
          this.checkAttribute(node, attr, name);
          this.line(indent, '__boolean(');
          this.expression({ source: attr.value, at: attr.at }, scope, false);
          this.file.write(');\n');
        } else if (classified.kind === 'property') {
          if (refusedProperty(name) !== undefined) {
            this.problem(attr.at, `${this.component.template}: property ${name} is forbidden`);
            continue;
          }
          const context = securityContextFor(node.tag, name);
          this.line(indent, '{ const __element = null as unknown as ');
          this.file.write(this.elementType(node.tag));
          this.file.write(`; void __element[${JSON.stringify(name)}]; `);
          if (context === undefined) {
            this.file.write(`__element[${JSON.stringify(name)}] = `);
            this.expression({ source: attr.value, at: attr.at }, scope, false);
          } else {
            this.file.write(`__${context}Sink(`);
            this.expression({ source: attr.value, at: attr.at }, scope, false);
            this.file.write(')');
          }
          this.file.write('; }\n');
        } else {
          this.checkAttribute(node, attr, name);
          this.line(indent, 'void (');
          this.expression({ source: attr.value, at: attr.at }, scope, false);
          this.file.write(');\n');
        }
        continue;
      }
      this.checkAttribute(node, attr, attr.name);
      this.interpolations(attr.value, attr.at, scope, indent);
    }
    this.nodes(node.children, scope, indent);
  }

  /**
   * Does this element react to the attribute the markup writes?
   *
   * A property binding to a name the class does not have is a type error and always was.
   * An *attribute* was invisible: `<ui-table empty-label="No rows">` set a string on an
   * element that observes `emptylabel` — or nothing at all, once the property became
   * standard text — and the only symptom was a missing label. Renaming a public property
   * left every caller compiling and silently inert.
   *
   * Custom elements only. The project model knows what each one observes, from
   * `static properties` and `static observedAttributes` both; nothing here knows the
   * attribute set of `<input>`, so a native element's attributes stay unchecked. An
   * element whose surface could not be read statically (`observedAttributes: null`) is
   * skipped for the same reason: silence beats an error nobody can act on.
   *
   * @param {ElementNode} node
   * @param {Attribute} attr As written, brackets and all, for the message.
   * @param {string} name The attribute the DOM would receive.
   */
  checkAttribute(node, attr, name) {
    const lower = name.toLowerCase();
    // A directive, or a typo of one. Directives are consumed before this point; the
    // dialect owns which ones exist, so the checker does not guess at `*maybe`.
    if (lower.startsWith('*')) return;
    if (lower.startsWith('aria-') || lower.startsWith('data-')) return;
    if (GLOBAL_ATTRIBUTES.has(lower)) return;

    const element = this.elements.get(node.tag);
    const observed = INTRINSIC_ELEMENTS.get(node.tag) ?? element?.observedAttributes;
    if (observed === undefined || observed === null) return;
    if (observed.includes(lower)) return;

    const properties = element?.properties ?? [];
    const property = camelCase(lower);
    if (properties.includes(property)) {
      this.problem(
        attr.at,
        `${this.component.template}: <${node.tag}> declares ${property} as a property with no ` +
          `attribute, so ${attr.name} does nothing. Bind it as [.${lower}].`,
      );
      return;
    }

    // A hyphen-insensitive match, because the near miss that matters is Lit's own:
    // `emptyLabel` answers to `emptylabel`, and every other name in the dialect is kebab.
    const flat = lower.split('-').join('');
    const near = observed.find((candidate) => candidate.split('-').join('') === flat);
    this.problem(
      attr.at,
      `${this.component.template}: <${node.tag}> does not observe the attribute ${attr.name}. ` +
        (near === undefined
          ? `Run \`node cli/project-model/index.mjs --element ${node.tag}\` for the ones it does.`
          : `Did you mean ${near}?`),
    );
  }

  /** @param {string} text @param {number} base @param {Map<string, string>} scope @param {number} indent */
  interpolations(text, base, scope, indent) {
    for (const match of text.matchAll(INTERPOLATION)) {
      const expression = match[1];
      if (expression === undefined || match.index === undefined) continue;
      this.line(indent, 'void (');
      this.expression({ source: expression, at: base + match.index + 2 }, scope, false);
      this.file.write(');\n');
    }
  }

  /** @param {BindingSource} binding @param {Map<string, string>} scope @param {boolean} assignment */
  expression(binding, scope, assignment) {
    try {
      const ast = parseExpression(binding.source, this.component.template, { allowAssignment: assignment });
      const emitted = this.emit(ast, scope, true, binding.at);
      this.file.mapped(emitted, this.component.template, binding.at);
    } catch (error) {
      this.problem(binding.at, error instanceof Error ? error.message : String(error));
      this.file.write('undefined');
    }
  }

  /** @param {import('@srljs/core/lib/core/template/types.js').ExprNode} node @param {Map<string, string>} scope @param {boolean} unwrap @param {number} at @returns {string} */
  emit(node, scope, unwrap, at) {
    /** @param {string} value @returns {string} */
    const wrap = (value) => (unwrap ? `__unwrap(${value})` : value);
    switch (node.kind) {
      case 'literal':
        return node.value === undefined ? 'undefined' : JSON.stringify(node.value);
      case 'name': {
        const local = scope.get(node.name);
        if (local !== undefined) return unwrap ? `__unwrap(${local})` : local;
        const global = this.globals.get(node.name);
        if (global !== undefined) {
          const id = globalIdentifier(node.name);
          return unwrap ? `__unwrap(${id})` : id;
        }
        let id = this.hostNames.get(node.name);
        if (id === undefined) {
          id = this.id(`host_${node.name}`);
          this.hostNames.set(node.name, id);
          this.hostOffsets.set(node.name, at + node.at);
        }
        return unwrap ? id : `__host[${JSON.stringify(node.name)}]`;
      }
      case 'member': {
        const object = this.emit(node.object, scope, true, at);
        return wrap(`(${object})${node.optional ? '?' : ''}.${node.name}`);
      }
      case 'index': {
        const object = this.emit(node.object, scope, true, at);
        const index = this.emit(node.index, scope, true, at);
        return wrap(`(${object})?.[${index}]`);
      }
      case 'call': {
        /** @type {string} */
        let callee;
        if (node.callee.kind === 'member') {
          const object = this.emit(node.callee.object, scope, true, at);
          callee = `(${object})${node.callee.optional ? '?' : ''}.${node.callee.name}`;
        } else callee = this.emit(node.callee, scope, false, at);
        return wrap(`${callee}(${node.args.map((arg) => this.emit(arg, scope, true, at)).join(', ')})`);
      }
      case 'unary':
        return `${node.operator}(${this.emit(node.operand, scope, true, at)})`;
      case 'binary':
        // `strictOperator`, so `==` type-checks as the `===` the evaluator runs.
        return `(${this.emit(node.left, scope, true, at)} ${strictOperator(node.operator)} ${this.emit(node.right, scope, true, at)})`;
      case 'conditional':
        return `(${this.emit(node.test, scope, true, at)} ? ${this.emit(node.consequent, scope, unwrap, at)} : ${this.emit(node.alternate, scope, unwrap, at)})`;
      case 'array':
        return `[${node.items.map((item) => this.emit(item, scope, true, at)).join(', ')}]`;
      case 'object':
        return `{ ${node.entries.map((entry) => `${JSON.stringify(entry.key)}: ${this.emit(entry.value, scope, true, at)}`).join(', ')} }`;
      case 'assign':
        return `__assign(${this.emit(node.target, scope, false, at)}, ${this.emit(node.value, scope, true, at)})`;
      case 'raw':
        return this.emit(node.operand, scope, false, at);
    }
  }

  /**
   * Is this element allowed here?
   *
   * "Allowed here" rather than "defined somewhere", which is the check this used
   * to make. A tag defined anywhere in the repository passed, so a template could
   * name a component whose module its application never imported and the only
   * symptom was an inert element on one route. What makes a tag available is the
   * component's own `uses` list — the same list that makes the element exist in the
   * browser — so the two agree by construction.
   *
   * @param {ElementNode} node
   */
  checkTag(node) {
    if (HTML_ELEMENTS.has(node.tag) || SVG_ELEMENTS.has(node.tag) || MATHML_ELEMENTS.has(node.tag)) return;
    if (this.available.has(node.tag)) return;

    const known = this.elements.get(node.tag);
    if (known !== undefined) {
      this.problem(
        node.at + 1,
        `${this.component.template}: <${node.tag}> is ${known.className} in ` +
          `${relative(REPO, known.module).split(sep).join('/')}, which this component does not ` +
          `import. Add \`${known.className}\` to its \`uses\`.`,
      );
      return;
    }
    this.problem(node.at + 1, `${this.component.template}: unknown element <${node.tag}>`);
  }

  /** @param {string} tag */
  elementType(tag) {
    const custom = this.elements.get(tag);
    if (custom?.exported === true) {
      return `InstanceType<typeof import(${JSON.stringify(moduleSpecifier(this.component.module, custom.module))})[${JSON.stringify(custom.className)}]>`;
    }
    if (HTML_ELEMENTS.has(tag)) return `HTMLElementTagNameMap[${JSON.stringify(tag)}]`;
    if (SVG_ELEMENTS.has(tag)) return `SVGElementTagNameMap[${JSON.stringify(tag)}]`;
    if (MATHML_ELEMENTS.has(tag)) return 'MathMLElement';
    return 'HTMLElement';
  }

  /** @param {number} at @param {string} message */
  problem(at, message) {
    this.problems.push({ at, message });
  }

  /** @param {number} indent @param {string} value */
  line(indent, value) {
    this.file.write(`${'  '.repeat(indent)}${value}`);
  }

  /** @param {string} label */
  id(label) {
    this.counter += 1;
    return `__${label.replace(/[^A-Za-z0-9_$]/gu, '_')}_${String(this.counter)}`;
  }
}

/** @param {ElementNode} node @param {string} name */
function attribute(node, name) {
  const found = node.attributes.find((candidate) => candidate.name === name);
  return found === undefined ? undefined : { source: found.value, at: found.at, value: found.value };
}

/** @param {string} name */
function globalIdentifier(name) {
  return `__global_${name.replace(/[^A-Za-z0-9_$]/gu, '_')}`;
}

/** @param {string} fromModule @param {string} target */
function moduleSpecifier(fromModule, target) {
  if (fromModule === target) return `./${target.slice(target.lastIndexOf(sep) + 1)}`;
  let path = relative(dirname(fromModule), target).split(sep).join('/');
  if (!path.startsWith('.')) path = `./${path}`;
  return path;
}

/** @param {string} source @param {number} at */
function lineAndColumn(source, at) {
  const before = source.slice(0, at);
  const lines = before.split('\n');
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

/**
 * The compiler, built once per process.
 *
 * Building a program from scratch costs about 2.5 seconds, and this is called once
 * per template. Three things are reused: the parsed tsconfig, the parsed source files,
 * and the previous program's structure via `oldProgram`. ADR-0039.
 *
 * The source-file cache is keyed by modified time, so a file edited on disk between two
 * calls is re-read — which matters for the editor seam more than for the CLI.
 *
 * @typedef {{
 *   options: ts.CompilerOptions,
 *   fileNames: string[],
 *   host: ts.CompilerHost,
 *   files: Map<string, { mtime: number, file: ts.SourceFile }>,
 *   generated: Map<string, GeneratedFile>,
 *   program: ts.Program | undefined,
 *   error: ts.Diagnostic | undefined,
 * }} CompilerState
 */

/** @type {CompilerState | undefined} */
let compiler;

/**
 * @returns {CompilerState}
 */
function compilerState() {
  if (compiler !== undefined) return compiler;

  const config = ts.readConfigFile(resolve(REPO, 'tsconfig.json'), (file) => ts.sys.readFile(file));
  const parsed =
    config.error === undefined
      ? ts.parseJsonConfigFileContent(config.config, ts.sys, REPO)
      : { options: {}, fileNames: [] };
  const options = {
    ...parsed.options,
    noEmit: true,
    noUnusedLocals: false,
    noUnusedParameters: false,
    isolatedModules: false,
  };

  /** @type {CompilerState} */
  const state = {
    options,
    fileNames: parsed.fileNames,
    host: ts.createCompilerHost(options),
    files: new Map(),
    generated: new Map(),
    program: undefined,
    error: config.error,
  };

  const originalGetSourceFile = state.host.getSourceFile.bind(state.host);
  state.host.fileExists = (file) =>
    state.generated.has(resolve(file)) || ts.sys.fileExists(file);
  state.host.readFile = (file) => state.generated.get(resolve(file))?.text ?? ts.sys.readFile(file);
  state.host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => {
    const path = resolve(file);
    const virtual = state.generated.get(path);
    if (virtual !== undefined) {
      // A shim is different text every call, so it is never cached.
      return ts.createSourceFile(file, virtual.text, languageVersion, true, ts.ScriptKind.TS);
    }

    const mtime = ts.sys.getModifiedTime?.(path)?.getTime() ?? 0;
    const cached = state.files.get(path);
    if (cached !== undefined && cached.mtime === mtime && shouldCreateNewSourceFile !== true) {
      return cached.file;
    }
    const source = originalGetSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile);
    if (source !== undefined) state.files.set(path, { mtime, file: source });
    return source;
  };

  compiler = state;
  return state;
}

/** @param {string[]} shimPaths @param {Map<string, GeneratedFile>} generated */
function typecheck(shimPaths, generated) {
  const state = compilerState();
  if (state.error !== undefined) return [state.error];

  state.generated = generated;
  const program = ts.createProgram({
    rootNames: [...state.fileNames, ...shimPaths],
    options: state.options,
    host: state.host,
    oldProgram: state.program,
  });
  state.program = program;

  const wanted = new Set(shimPaths.map((path) => resolve(path)));
  return ts.getPreEmitDiagnostics(program).filter((diagnostic) =>
    diagnostic.file === undefined ? true : wanted.has(resolve(diagnostic.file.fileName)),
  );
}

/**
 * Check one in-memory template. This is also a small editor/tooling seam: a
 * caller can validate unsaved markup without creating a shim on disk.
 *
 * `available` is the component's `uses` list already resolved to tags. Omitted, it
 * defaults to every element in `elements`, which is what an editor checking
 * unsaved markup wants: the file being edited may not declare its dependency yet.
 *
 * @param {{
 *   module: string,
 *   className: string,
 *   template: string,
 *   source: string,
 *   elements?: Map<string, ElementType>,
 *   globals?: Map<string, TemplateGlobal>,
 *   available?: Set<string>,
 * }} input
 * @returns {string[]}
 */
export function checkTemplateSource(input) {
  const elements = input.elements ?? new Map();
  const component = {
    module: resolve(input.module),
    className: input.className,
    template: input.template,
    available: new Set([...INTRINSIC_ELEMENTS.keys(), ...(input.available ?? elements.keys())]),
  };
  const builder = new ShimBuilder(
    component,
    parseTemplate(input.source, input.template),
    elements,
    input.globals ?? new Map(),
  );
  const generatedFile = builder.build();
  const shim = resolve(dirname(component.module), `.${component.className}.template-check.ts`);
  const diagnostics = typecheck([shim], new Map([[shim, generatedFile]]));
  return [
    ...builder.problems.map((problem) => problem.message),
    ...diagnostics.map((diagnostic) =>
      `TS${String(diagnostic.code)}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
    ),
  ];
}

/** @param {Application} app */
async function checkApplication(app) {
  const discovered = await discover(app);
  /** @type {Map<string, GeneratedFile>} */
  const generated = new Map();
  /** @type {{ template: string, source: string, generated: GeneratedFile, problems: { at: number, message: string }[] }[]} */
  const details = [];

  for (const component of discovered.components) {
    let source;
    try {
      source = await readFile(component.template, 'utf8');
    } catch (error) {
      console.error(`${relative(REPO, component.template)}: cannot read template: ${String(error)}`);
      continue;
    }
    const tree = parseTemplate(source, component.template);
    const builder = new ShimBuilder(component, tree, discovered.elements, discovered.globals);
    const built = builder.build();
    const shimPath = resolve(dirname(component.module), `.${component.className}.template-check.ts`);
    generated.set(shimPath, built);
    details.push({ template: component.template, source, generated: built, problems: builder.problems });
  }

  const diagnostics = typecheck([...generated.keys()], generated);
  let failures = 0;
  for (const detail of details) {
    for (const problem of detail.problems) {
      const position = lineAndColumn(detail.source, problem.at);
      console.error(
        `${relative(REPO, detail.template)}:${String(position.line)}:${String(position.column)} - error: ${problem.message}`,
      );
      failures += 1;
    }
  }
  for (const diagnostic of diagnostics) {
    if (diagnostic.file === undefined || diagnostic.start === undefined) {
      console.error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
      failures += 1;
      continue;
    }
    const built = generated.get(resolve(diagnostic.file.fileName));
    const detail = details.find((item) => item.generated === built);
    if (built === undefined || detail === undefined) continue;
    const start = diagnostic.start;
    const mapping = built.mappings
      .filter((candidate) => candidate.start <= start && start <= candidate.end)
      .sort((left, right) => left.end - left.start - (right.end - right.start))[0];
    const at = mapping?.at ?? 0;
    const position = lineAndColumn(detail.source, at);
    console.error(
      `${relative(REPO, detail.template)}:${String(position.line)}:${String(position.column)} - error TS${String(diagnostic.code)}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
    );
    failures += 1;
  }

  if (failures === 0) {
    console.log(`  ok   ${app.name}: ${String(discovered.components.length)} template(s) typechecked`);
  }
  return failures;
}

export async function main() {
  const all = await apps();
  const appIndex = process.argv.indexOf('--app');
  const requested = appIndex === -1 ? undefined : process.argv[appIndex + 1];
  const selected = requested === undefined ? all : all.filter((app) => app.name === requested);
  if (selected.length === 0) {
    console.error(`Unknown application ${JSON.stringify(requested)}. Found: ${all.map((app) => app.name).join(', ')}`);
    return 1;
  }

  console.log('Template typecheck');
  let failures = 0;
  for (const app of selected) failures += await checkApplication(app);
  if (failures > 0) console.error(`\n${String(failures)} template type error(s).`);
  else console.log('\nAll templates passed static type checking.');
  return failures === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
