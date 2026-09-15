/**
 * Component identity: a component's tag, its class, its template and the
 * components its template may name.
 *
 *     await defineComponent({
 *       tag: 'users-page',
 *       element: UsersPage,
 *       module: import.meta.url,
 *       uses: [UiCard],
 *     });
 *
 * The template is the module's sibling `.html`. Routes, outlets, remote entries
 * and the startup root all take the class, and `tagOf` reads the tag back.
 *
 * `uses` lists child components as imported classes. The import guarantees each
 * child is defined first, and the template checker reads the list, so an unlisted
 * tag is a build error.
 *
 * `reviseComponentModule` applies a development edit to a class the registry
 * already holds. ADR-0113.
 */

import { attachTemplate } from '@core/template/template.js';
import { attachStylesheet } from '@core/elements/stylesheet.js';

/** @import { ComponentDefinition, ComponentRef, ComponentSpec } from '@core/elements/types.js' */

/** @type {WeakMap<CustomElementConstructor, ComponentDefinition>} */
const byClass = new WeakMap();

/**
 * Components declared by each module URL, for development revisions.
 *
 * @type {Map<string, Set<ComponentDefinition>>}
 */
const byModule = new Map();

/**
 * Definitions this module created, so `resolveTag` can tell one from a module
 * namespace object.
 *
 * @type {WeakSet<ComponentDefinition>}
 */
const definitions = new WeakSet();

/**
 * Declare a component. A component module ends by awaiting this call.
 *
 * The template and stylesheet load before `customElements.define`, because
 * defining upgrades existing elements and an early render would show empty
 * markup. `uses` is validated before that, so a missing dependency fails before
 * any element exists.
 *
 * @param {ComponentSpec} spec
 * @returns {Promise<ComponentDefinition>}
 */
export async function defineComponent(spec) {
  const { tag, element } = spec;
  assertTag(tag);
  assertModule(tag, spec.module);

  // A revision query marks a re-import from `reviseComponentModule`. Everything
  // else uses the URL without it.
  const module = withoutRevision(spec.module);

  const existing = customElements.get(tag);
  if (existing !== undefined) {
    const already = byClass.get(element);
    // The same class under the same tag is a no-op, so a module served from two
    // URLs still works. A different class is a collision unless a revision
    // declared it.
    if (existing === element && already !== undefined) return already;
    if (module !== spec.module) return adoptRevision(tag, existing, spec, module);
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
  const styled = stylesDeclared(tag, spec, templateUrl);
  const stylesheetUrl = spec.styles === true ? stylesheetUrlFor(module) : undefined;

  // Both before `define`, because the first render needs its markup and its rules.
  await Promise.all([
    templateUrl === undefined
      ? undefined
      : attachTemplate(element, templateUrl, styled ? tag : undefined),
    stylesheetUrl === undefined ? undefined : attachStylesheet(tag, stylesheetUrl),
  ]);

  /** @type {ComponentDefinition} */
  const definition = Object.freeze({
    tag,
    element,
    module,
    templateUrl,
    styled,
    stylesheetUrl,
    uses: Object.freeze(uses),
  });
  definitions.add(definition);
  byClass.set(element, definition);
  declaredIn(module).add(definition);

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
 * The tag a reference names. Accepts a class, a definition or a tag string.
 *
 * A class without a definition throws, because its module either called
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
 * `@core/elements/mount.js` calls this on whatever a `load` function resolved to.
 * A module namespace object names nothing and returns undefined. A class without
 * a definition still throws.
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

/* ── Development revisions ─────────────────────────────────────────────── */

/**
 * The query that marks a module re-imported after an edit.
 *
 * The module map keys entries by URL, so an edited file only runs again under a
 * new URL. Only the edited module gets the query, so its imports keep their
 * identity (ADR-0017).
 */
const REVISION = 'srl-revision';

let revisionSerial = 0;

/**
 * Definitions adopted by the revision in progress, keyed by module. Filled by
 * `adoptRevision` while the module body runs, and read by `reviseComponentModule`
 * once the import resolves.
 *
 * @type {Map<string, Set<ComponentDefinition>>}
 */
const adopting = new Map();

/**
 * A private name anywhere in a class body.
 *
 * Matches `this.#total`, `#total = 0` and `#total()`. Skips `'#main'` and
 * `` `#${id}` ``, because a private name never follows a quote. A false match only
 * costs a reload.
 */
const PRIVATE_NAME = /(?:^|[\s;{}(])#[A-Za-z_$][\w$]*|\.\s*#[A-Za-z_$][\w$]*/mu;

/**
 * A host that can be told its class changed. `SignalElement` implements it.
 *
 * @typedef {{ renderRevisedDefinition?: () => void }} RevisableHost
 */

/**
 * Apply an edited component module to the running page. Development only.
 *
 * The module runs again, and each component it declares either adopts the new
 * class body or throws with the reason. The caller reloads on a throw. ADR-0113.
 *
 * The tag keeps its registered class. Methods, accessors and statics move onto
 * that class, so existing and future elements run the same code. Fields and
 * private names can't move, and `assertReplaceable` refuses edits that change
 * them.
 *
 * @internal
 * @param {string | URL} url
 * @returns {Promise<boolean>} Whether this page replaced the module. `false` means
 *   the module declares no component here, and the caller should reload.
 */
export async function reviseComponentModule(url) {
  const href = withoutRevision(new URL(url, document.baseURI).href);
  const declared = byModule.get(href);
  if (declared === undefined || declared.size === 0) return false;

  revisionSerial += 1;
  /** @type {Set<ComponentDefinition>} */
  const adopted = new Set();
  adopting.set(href, adopted);
  try {
    await import(`${href}${href.includes('?') ? '&' : '?'}${REVISION}=${String(revisionSerial)}`);
  } finally {
    adopting.delete(href);
  }

  for (const definition of declared) {
    if (adopted.has(definition)) continue;
    throw new Error(
      `<${definition.tag}> was declared in ${href} and the edited file no longer declares it. ` +
        `A component that stops existing is an identity change, not a revision.`,
    );
  }

  for (const definition of adopted) renderRevisedHosts(definition);
  return true;
}

/**
 * Install an edited class body on the class the registry holds.
 *
 * @param {string} tag
 * @param {CustomElementConstructor} registered
 * @param {ComponentSpec} spec
 * @param {string} module The declaring URL, without the revision query.
 * @returns {ComponentDefinition}
 */
function adoptRevision(tag, registered, spec, module) {
  const previous = byClass.get(registered);
  if (previous === undefined) {
    throw new Error(
      `<${tag}> is registered by a bare \`customElements.define\`, so ${module} cannot be ` +
        `replaced in place: this module owns no record of what the tag renders.`,
    );
  }

  assertReplaceable(previous, spec, module);
  adoptClassBody(registered, spec.element);
  adopting.get(module)?.add(previous);

  // The same definition object, because a revision may not change anything it records.
  return previous;
}

/**
 * Throw when a live page can't adopt an edit, naming what changed.
 *
 * Fields and private names are installed per instance, and reactive properties
 * are fixed at `define` time. The base class, template and `uses` are identity.
 * Only the prototype and the statics can move.
 *
 * @param {ComponentDefinition} previous
 * @param {ComponentSpec} spec
 * @param {string} module
 */
function assertReplaceable(previous, spec, module) {
  const { tag } = previous;
  const registered = previous.element;
  const fresh = spec.element;

  /** @param {string} what */
  const refuse = (what) => {
    throw new Error(
      `<${tag}> cannot be replaced in place: ${what}. The edit is in ${module}, and a page ` +
        `already running the old class has to start again to run this one.`,
    );
  };

  const styled = stylesDeclared(tag, spec, previous.templateUrl);
  if (styled !== previous.styled) {
    refuse(`it ${styled ? 'declares' : 'no longer declares'} a stylesheet`);
  }

  if (Reflect.getPrototypeOf(fresh) !== Reflect.getPrototypeOf(registered)) {
    refuse('it extends a different class than the one on screen does');
  }

  const templateUrl = spec.template === false ? undefined : templateUrlFor(module, spec.template);
  if (templateUrl !== previous.templateUrl) refuse('it renders a different template');

  const uses = (spec.uses ?? []).map((ref) => requireDefinition(ref, tag));
  if (uses.length !== previous.uses.length || uses.some((one, at) => one !== previous.uses[at])) {
    refuse('its `uses` names different components');
  }

  if (PRIVATE_NAME.test(String(fresh))) {
    refuse(
      'it keeps state in private fields, and a class evaluated again mints private names of ' +
        'its own that no element on screen carries',
    );
  }

  if (!sameProperties(registered, fresh)) refuse('it declares different reactive properties');
  if (!sameFields(registered, fresh)) refuse('its fields changed');
}

/**
 * Whether two classes declare the same reactive properties.
 *
 * Lit turns `static properties` into prototype accessors and observed attributes
 * once, at `finalize`, so a change needs a reload.
 *
 * @param {CustomElementConstructor} registered
 * @param {CustomElementConstructor} fresh
 * @returns {boolean}
 */
function sameProperties(registered, fresh) {
  return describeProperties(registered) === describeProperties(fresh);
}

/**
 * @param {CustomElementConstructor} element
 * @returns {string}
 */
function describeProperties(element) {
  const declared = /** @type {{ properties?: Record<string, unknown> }} */ (
    /** @type {unknown} */ (element)
  ).properties;
  if (!Object.hasOwn(element, 'properties') || declared === undefined) return '';
  return Object.keys(declared)
    .sort()
    .map((name) => `${name}:${JSON.stringify(declared[name]) ?? ''}`)
    .join(' ');
}

/**
 * Whether two classes install the same instance fields.
 *
 * Builds one element from each class, since only construction shows what the
 * initializers produce. `Reflect.construct` with the registered class as
 * `new.target` makes the unregistered class constructible. Neither element is
 * inserted.
 *
 * Field names must match, and so must primitive values. Objects, signals and
 * functions differ between any two instances, so they are skipped.
 *
 * @param {CustomElementConstructor} registered
 * @param {CustomElementConstructor} fresh
 * @returns {boolean}
 */
function sameFields(registered, fresh) {
  /** @type {object} */
  let before;
  /** @type {object} */
  let after;
  try {
    before = new registered();
    after = Reflect.construct(fresh, [], registered);
  } catch {
    // A constructor that fails outside the document can't be compared, so reload.
    return false;
  }

  const names = Reflect.ownKeys(after);
  if (names.length !== Reflect.ownKeys(before).length) return false;

  const one = /** @type {Record<PropertyKey, unknown>} */ (before);
  const other = /** @type {Record<PropertyKey, unknown>} */ (after);
  for (const name of names) {
    if (!Object.hasOwn(before, name)) return false;
    const value = other[name];
    if (value !== null && (typeof value === 'object' || typeof value === 'function')) continue;
    if (!Object.is(value, one[name])) return false;
  }
  return true;
}

/**
 * Copy an edited class body onto the registered class.
 *
 * Only own members move, and a member the edit deleted is deleted here too.
 * Reactive property accessors are skipped, because each one reads a storage key
 * Lit generated for the registered class.
 *
 * @param {CustomElementConstructor} registered
 * @param {CustomElementConstructor} fresh
 */
function adoptClassBody(registered, fresh) {
  const reactive = /** @type {{ elementProperties?: Map<PropertyKey, unknown> }} */ (
    /** @type {unknown} */ (registered)
  ).elementProperties;

  /** @param {PropertyKey} key */
  const owned = (key) => key !== 'constructor' && reactive?.has(key) !== true;

  // `CustomElementConstructor` types `prototype` as `any`, so narrow it once here.
  const target = /** @type {{ prototype: object }} */ (/** @type {unknown} */ (registered))
    .prototype;
  const source = /** @type {{ prototype: object }} */ (/** @type {unknown} */ (fresh)).prototype;
  for (const key of Reflect.ownKeys(target)) {
    if (owned(key) && !Object.hasOwn(source, key)) Reflect.deleteProperty(target, key);
  }
  for (const key of Reflect.ownKeys(source)) {
    if (!owned(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor !== undefined) Object.defineProperty(target, key, descriptor);
  }

  // Statics are copied and never deleted. Every class owns `prototype`, `length`
  // and `name`, and the registered class also holds Lit's `finalize` bookkeeping.
  for (const key of Reflect.ownKeys(fresh)) {
    if (key === 'prototype' || key === 'length' || key === 'name') continue;
    const descriptor = Object.getOwnPropertyDescriptor(fresh, key);
    if (descriptor !== undefined) Object.defineProperty(registered, key, descriptor);
  }
}

/**
 * Ask every live host of a revised class to render.
 *
 * Walks the document instead of tracking hosts, so production pays nothing.
 * `instanceof` also matches subclasses.
 *
 * @param {ComponentDefinition} definition
 */
function renderRevisedHosts(definition) {
  for (const element of document.querySelectorAll('*')) {
    if (!(element instanceof definition.element)) continue;
    /** @type {RevisableHost} */ (/** @type {unknown} */ (element)).renderRevisedDefinition?.();
  }
}

/**
 * The set of definitions declared in a module, created on first use.
 *
 * @param {string} module
 * @returns {Set<ComponentDefinition>}
 */
function declaredIn(module) {
  let declared = byModule.get(module);
  if (declared === undefined) {
    declared = new Set();
    byModule.set(module, declared);
  }
  return declared;
}

/**
 * A module URL without the revision query. Returns the same string when there is
 * none, so the common path allocates nothing.
 *
 * @param {string} moduleUrl
 * @returns {string}
 */
function withoutRevision(moduleUrl) {
  if (!moduleUrl.includes(`${REVISION}=`)) return moduleUrl;
  const parsed = new URL(moduleUrl, document.baseURI);
  parsed.searchParams.delete(REVISION);
  return parsed.href;
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
 * The module's sibling `.html`, or the path a spec named instead.
 *
 * Deriving the URL means a renamed module can't point at a stale template. Both
 * forms resolve against the module, so a component works from any origin.
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
 * The module's sibling `.css`.
 *
 * @param {string} moduleUrl
 * @returns {string}
 */
function stylesheetUrlFor(moduleUrl) {
  const module = new URL(moduleUrl);
  const file = module.pathname.slice(module.pathname.lastIndexOf('/') + 1);
  return new URL(file.replace(/\.js$/u, '.css'), module).href;
}

/**
 * Whether a spec declares a stylesheet. Throws when the Element can't have one.
 *
 * A stylesheet reaches the markup its template renders, so an Element with
 * `template: false` has nothing to style. ADR-0119.
 *
 * @param {string} tag
 * @param {ComponentSpec} spec
 * @param {string | undefined} templateUrl
 * @returns {boolean}
 */
function stylesDeclared(tag, spec, templateUrl) {
  const { styles } = spec;
  if (styles !== undefined && styles !== true && styles !== false && styles !== 'bundled') {
    throw new Error(
      `<${tag}>: \`styles\` must be true or false, and ${JSON.stringify(styles)} is neither.`,
    );
  }
  const styled = styles === true || styles === 'bundled';
  if (styled && templateUrl === undefined) {
    throw new Error(
      `<${tag}> declares \`styles\` and \`template: false\`. An Element's stylesheet reaches ` +
        'the markup its template renders, and this one renders none. ADR-0119.',
    );
  }
  return styled;
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
  // The parser's own rule. `customElements.define` would throw a SyntaxError that
  // names neither the class nor the module.
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
