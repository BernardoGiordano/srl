/**
 * The project model as a Custom Elements Manifest, schema 2.1.0, the format Storybook,
 * IDE plugins and documentation tools read to learn what an element offers.
 *
 * An adapter and nothing else. Every fact comes from the model the template checker
 * and the language server read, so the manifest cannot disagree with them. The model
 * knows each element's tag, class, module, public inputs and their attributes, the
 * events it dispatches and its projection names. It holds no prose, so the manifest
 * carries no descriptions. ADR-0127.
 *
 *   srl model --custom-elements    the application's own elements
 *
 * The library's collection ships its manifest at the package root, written by
 * `npm run package` and named by the `customElements` field of its package.json.
 */

import { relative, sep } from 'node:path';

/** @import { ElementRecord, ProjectModel } from './types.js' */

/** The schema this adapter writes. */
export const CUSTOM_ELEMENTS_SCHEMA = '2.1.0';

/**
 * @typedef {{ name: string, module?: string }} Reference
 * @typedef {{ kind: 'javascript-module', path: string, declarations: object[], exports: object[] }} JavaScriptModule
 * @typedef {{ schemaVersion: string, modules: JavaScriptModule[] }} CustomElementsManifest
 */

/**
 * @param {string} base
 * @param {string} file
 * @returns {string}
 */
function modulePath(base, file) {
  return relative(base, file).split(sep).join('/');
}

/**
 * The declaration for one element.
 *
 * @param {ElementRecord} record
 * @param {string} base
 * @returns {object}
 */
function declaration(record, base) {
  /** @param {{ module: string, className: string }} at @returns {{ inheritedFrom?: Reference }} */
  const inherited = (at) =>
    at.className === record.className && at.module === record.module
      ? {}
      : { inheritedFrom: { name: at.className, module: modulePath(base, at.module) } };

  const inputs = record.propertyDeclarations.filter((property) => property.kind === 'input');
  const fieldFor = new Map(
    inputs.flatMap((property) =>
      typeof property.attribute === 'string' ? [[property.attribute, property]] : [],
    ),
  );

  return {
    kind: 'class',
    name: record.className,
    customElement: true,
    tagName: record.tag,
    members: inputs.map((property) => ({
      kind: 'field',
      name: property.name,
      privacy: 'public',
      ...inherited(property.declaration),
    })),
    attributes: (record.observedAttributes ?? []).map((name) => {
      const property = fieldFor.get(name);
      return property === undefined
        ? { name }
        : { name, fieldName: property.name, ...inherited(property.declaration) };
    }),
    events: record.events.map((event) => ({
      name: event.name,
      type: { text: event.event },
      ...inherited(event.declaration),
    })),
    slots: (record.slots ?? []).map((name) => ({ name })),
  };
}

/**
 * The manifest for every element `include` accepts, with module paths relative to
 * `base`, sorted so two runs write the same bytes.
 *
 * @param {ProjectModel} model
 * @param {{ base: string, include: (record: ElementRecord) => boolean }} options
 * @returns {CustomElementsManifest}
 */
export function customElementsManifest(model, options) {
  /** @type {Map<string, ElementRecord[]>} */
  const byModule = new Map();
  for (const record of model.elements.values()) {
    if (!options.include(record)) continue;
    const path = modulePath(options.base, record.module);
    byModule.set(path, [...(byModule.get(path) ?? []), record]);
  }

  return {
    schemaVersion: CUSTOM_ELEMENTS_SCHEMA,
    modules: [...byModule.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, records]) => {
        const sorted = [...records].sort((left, right) => left.tag.localeCompare(right.tag));
        return {
          kind: /** @type {const} */ ('javascript-module'),
          path,
          declarations: sorted.map((record) => declaration(record, options.base)),
          exports: sorted.flatMap((record) => {
            const reference = { name: record.className, module: path };
            return [
              ...(record.exported ? [{ kind: 'js', name: record.className, declaration: reference }] : []),
              { kind: 'custom-element-definition', name: record.tag, declaration: reference },
            ];
          }),
        };
      }),
  };
}
