/**
 * Custom-element identity: what a component is called, which markup it renders,
 * and which other components its markup is allowed to name. One record per
 * component, stated once:
 *
 *     await defineComponent({
 *       tag: 'users-page',
 *       element: UsersPage,
 *       module: import.meta.url,
 *       uses: [UiCard],
 *     });
 *
 * The template is not named: it is the sibling `.html` of the module. Nothing
 * else in an application names the tag either — a route, an outlet target, a
 * remote entry and the startup root all take the *class*, and `tagOf` reads its
 * tag back out of this registry.
 *
 * `uses` is the dependency written as a value rather than as a side-effect
 * import. A `.html` file cannot import, so markup saying `<ui-card>` depends on
 * `ui-card.js` having evaluated; naming the class is a real ESM import, so module
 * evaluation order guarantees the child is defined first — a module body runs
 * after every module it imports, top-level `await` included. It is also the fact
 * the template checker reads, so an unlisted tag is a build error naming the
 * class to add rather than a blank element at runtime.
 */

import { attachTemplate } from '@core/template/template.js';

/** @import { ComponentDefinition, ComponentRef, ComponentSpec } from '@core/elements/types.js' */

/** @type {WeakMap<CustomElementConstructor, ComponentDefinition>} */
const byClass = new WeakMap();

/**
 * Brand for `ComponentDefinition`. A definition and a module namespace object are
 * both "an object with properties" to `typeof`, and `resolveTag` has to tell a
 * definition it created from whatever a `load` function happened to resolve to.
 *
 * @type {WeakSet<ComponentDefinition>}
 */
const definitions = new WeakSet();

/**
 * Declare a component: its tag, its class, its template, and the components its
 * template may name.
 *
 * Awaited, and a component module ends with it, so a module is not "loaded" until
 * its element is defined and can render. Every dynamic mount relies on that:
 * `@core/elements/mount.js` treats a tag still undefined after its `load` resolved
 * as an error rather than waiting for one that is never coming.
 *
 * The order inside is the point. The template is fetched and compiled first,
 * because `customElements.define` upgrades elements already in the document and
 * Lit renders on connection, so defining first would flash empty markup. `uses`
 * is validated before that, so a missing dependency fails before an element
 * exists rather than as an unknown tag in the middle of a render.
 *
 * @param {ComponentSpec} spec
 * @returns {Promise<ComponentDefinition>}
 */
export async function defineComponent(spec) {
  const { tag, element, module } = spec;
  assertTag(tag);
  assertModule(tag, module);

  const existing = customElements.get(tag);
  if (existing !== undefined) {
    const already = byClass.get(element);
    // Re-declaring the same class with the same tag is a no-op, which keeps a
    // module served under two URLs from taking the page down. A *different*
    // class claiming a taken tag is the identity collision this module exists to
    // make impossible to have silently.
    if (existing === element && already !== undefined) return already;
    if (existing === element) {
      throw new Error(
        `<${tag}> is already registered for ${describeClass(element)} by a bare ` +
          `\`customElements.define\`, so its template cannot be attached: instances that already ` +
          `exist have rendered without one. Declare it here instead, in ${module}.`,
      );
    }
    throw new Error(
      `<${tag}> is already defined by ${describeClass(existing)}, so ${describeClass(element)} ` +
        `in ${module} cannot also claim it. A tag is one component's identity.`,
    );
  }

  const uses = (spec.uses ?? []).map((ref) => requireDefinition(ref, tag));
  const templateUrl =
    spec.template === false ? undefined : templateUrlFor(module, spec.template);

  if (templateUrl !== undefined) await attachTemplate(element, templateUrl);

  /** @type {ComponentDefinition} */
  const definition = Object.freeze({
    tag,
    element,
    module,
    templateUrl,
    uses: Object.freeze(uses),
  });
  definitions.add(definition);
  byClass.set(element, definition);

  customElements.define(tag, element);
  return definition;
}

/**
 * The definition of a class, or undefined when it has none.
 *
 * @param {CustomElementConstructor} element
 * @returns {ComponentDefinition | undefined}
 */
export function definitionOf(element) {
  return byClass.get(element);
}

/**
 * The tag a reference names. A class, its definition and a plain tag string are
 * all accepted, so a route table, an outlet target and a remote entry can hold
 * whichever of the three they already have in scope.
 *
 * A class with no definition throws rather than returning undefined: a class is
 * only in scope because its module was imported, so its module either called
 * `defineComponent` or has a bug.
 *
 * @param {ComponentRef} ref
 * @returns {string}
 */
export function tagOf(ref) {
  if (typeof ref === 'string') return ref;
  if (isDefinition(ref)) return ref.tag;

  const definition = byClass.get(ref);
  if (definition === undefined) {
    throw new Error(
      `${describeClass(ref)} has no component definition. A component module ends with ` +
        `\`await defineComponent({ tag, element, module: import.meta.url })\`, and nothing may ` +
        `name the class before that has run.`,
    );
  }
  return definition.tag;
}

/**
 * The tag in an arbitrary value, or undefined when it names no component.
 *
 * The tolerant half of `tagOf`, for the one caller that cannot know what it is
 * holding: `@core/elements/mount.js` inspects whatever a `load` function resolved to, and
 * a module namespace object — `() => import('./users-page.js')` — legitimately
 * names nothing. A class is still strict, because a class that reached a mount
 * request without a definition is a mistake with an exact cause.
 *
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function resolveTag(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'function') return tagOf(/** @type {CustomElementConstructor} */ (value));
  if (isDefinition(value)) return value.tag;
  return undefined;
}

/**
 * @param {unknown} value
 * @returns {value is ComponentDefinition}
 */
function isDefinition(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    definitions.has(/** @type {ComponentDefinition} */ (value))
  );
}

/**
 * The sibling `.html` of the declaring module, or the path a spec named instead.
 *
 * Derived rather than declared so that renaming `users-page.js` cannot leave a
 * `templateUrl` pointing at the old name. `template` stays available for the
 * component whose markup is not a sibling — a test fixture, or two components
 * sharing one layout — and is resolved against the module either way, so a
 * component keeps working wherever it is served from, including out of a
 * micro-frontend on another origin.
 *
 * @param {string} moduleUrl
 * @param {string | undefined} template
 * @returns {string}
 */
function templateUrlFor(moduleUrl, template) {
  const module = new URL(moduleUrl);
  const file = module.pathname.slice(module.pathname.lastIndexOf('/') + 1);
  return new URL(template ?? file.replace(/\.js$/u, '.html'), module).href;
}

/**
 * @param {ComponentRef} ref
 * @param {string} tag
 * @returns {ComponentDefinition}
 */
function requireDefinition(ref, tag) {
  if (isDefinition(ref)) return ref;
  if (typeof ref === 'string') {
    throw new Error(
      `<${tag}>: \`uses\` entry ${JSON.stringify(ref)} is a tag string. List the component's ` +
        `class instead, so the import that makes the element exist is what declares the ` +
        `dependency.`,
    );
  }

  const definition = byClass.get(ref);
  if (definition === undefined) {
    throw new Error(
      `<${tag}>: \`uses\` names ${describeClass(ref)}, which has no component definition. Its ` +
        `module must end with \`await defineComponent(...)\`; until it does, importing it does ` +
        `not make its element exist.`,
    );
  }
  return definition;
}

/**
 * @param {string} tag
 */
function assertTag(tag) {
  // The parser's own rule, stated where the mistake is made. `customElements.define`
  // throws a SyntaxError naming neither the class nor the module, and a tag typo is
  // exactly the kind of thing that reaches production in a rarely visited view.
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]*)+$/u.test(tag)) {
    throw new Error(
      `${JSON.stringify(tag)} is not a valid custom element name. It must start with a ` +
        `lowercase letter and contain a hyphen.`,
    );
  }
}

/**
 * @param {string} tag
 * @param {string} module
 */
function assertModule(tag, module) {
  if (typeof module !== 'string' || !module.includes('/')) {
    throw new Error(
      `<${tag}>: \`module\` must be \`import.meta.url\`. It anchors the template beside the ` +
        `module and names the file in every error about this component. Got ` +
        `${JSON.stringify(module)}.`,
    );
  }
}

/**
 * @param {CustomElementConstructor} element
 * @returns {string}
 */
function describeClass(element) {
  return element.name === '' ? 'an anonymous class' : `class ${element.name}`;
}
