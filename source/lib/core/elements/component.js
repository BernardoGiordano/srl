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
 *
 * Because a tag's class is permanent, this module is also where a development
 * JavaScript edit is decided. `reviseComponentModule` runs an edited module again
 * and installs its class body on the class the registry already holds, or refuses
 * and names what changed. Identity is what a revision may not move, and identity
 * lives here. ADR-0113.
 */

import { attachTemplate } from '@core/template/template.js';

/** @import { ComponentDefinition, ComponentRef, ComponentSpec } from '@core/elements/types.js' */

/** @type {WeakMap<CustomElementConstructor, ComponentDefinition>} */
const byClass = new WeakMap();

/**
 * Which components a module declared, for the development replacement path below.
 *
 * `byClass` answers "what is this class called", and a JavaScript edit asks the
 * question the other way round: it names a module URL and needs the components
 * declared in it. One entry per component, held strongly, which costs nothing
 * anyone else is not already paying — `customElements.define` retains every class
 * for the life of the page.
 *
 * @type {Map<string, Set<ComponentDefinition>>}
 */
const byModule = new Map();

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
  const { tag, element } = spec;
  assertTag(tag);
  assertModule(tag, spec.module);

  // A module re-imported by `reviseComponentModule` carries a revision query, and
  // that query is the whole of how a redeclaration is told from a collision. The
  // normalised URL is what everything else uses, so a revised module's template
  // stays the one URL the page already fetched.
  const module = withoutRevision(spec.module);

  const existing = customElements.get(tag);
  if (existing !== undefined) {
    const already = byClass.get(element);
    // Re-declaring the same class with the same tag is a no-op, which keeps a
    // module served under two URLs from taking the page down. A *different*
    // class claiming a taken tag is the identity collision this module exists to
    // make impossible to have silently — unless the edited module declared it,
    // in which case it is a revision of the component that already exists.
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

/* ── Development revisions ─────────────────────────────────────────────── */

/**
 * The query that marks a module re-imported after an edit.
 *
 * The browser's module map keys an entry by URL, so a changed file is only
 * evaluated again under a URL it has not been evaluated under. The query goes on
 * the edited module and nowhere else: its own imports still name the URLs the rest
 * of the page holds, so a revision duplicates one module rather than a graph, and
 * dependency identity stays what ADR-0017 says it is.
 */
const REVISION = 'srl-revision';

let revisionSerial = 0;

/**
 * Definitions adopted by the revision in progress, keyed by the module being
 * revised. Written by `adoptRevision` while the re-imported module body is
 * running, drained by `reviseComponentModule` once the import resolves.
 *
 * @type {Map<string, Set<ComponentDefinition>>}
 */
const adopting = new Map();

/**
 * A private name written anywhere in a class body.
 *
 * `this.#total`, `#total = 0` and `#total()` all match; `'#main'` in a selector
 * and `` `#${id}` `` in a template literal do not, because a private name never
 * follows a quote. Over-matching is safe and under-matching is not: the answer to
 * a private name is a reload, and a reload is always correct.
 */
const PRIVATE_NAME = /(?:^|[\s;{}(])#[A-Za-z_$][\w$]*|\.\s*#[A-Za-z_$][\w$]*/mu;

/**
 * The one thing `renderRevisedHosts` needs of a host is a way to be told its class
 * changed. `SignalElement` has it.
 *
 * @typedef {{ renderRevisedDefinition?: () => void }} RevisableHost
 */

/**
 * Run an edited component module in the page that is already running it.
 *
 * Development only. An editor saves a `.js` file, the development server names the
 * URL it is served at, and its browser adapter calls this. The module is evaluated
 * again, and every component it declares either adopts its new class body or
 * refuses and says why — a refusal is a thrown error, and the adapter answers one
 * with the reload it would have done anyway. ADR-0113.
 *
 * The tag keeps the class it was registered with, because `customElements.define`
 * is permanent and a route, an outlet target and a remote entry all hold that
 * class. What moves is the class *body*: the methods, the accessors and the statics
 * the edit rewrote are installed on the registered class, so a host already on
 * screen and an element created a minute later run the same code.
 *
 * What cannot move is anything the constructor installs. Field initialisers run
 * once per instance, from the constructor of the class the registry holds, and
 * nothing can make them run again on an element that already exists. Private names
 * are worse than that: a re-evaluated class body mints new ones, so a method
 * adopted from it would read a field no live instance carries. Both are refused
 * rather than half-applied — see `assertReplaceable` for the whole list.
 *
 * @internal
 * @param {string | URL} url
 * @returns {Promise<boolean>} Whether this page replaced the module. `false` means
 *   no component was declared in it, so there is nothing here to replace and the
 *   caller should reload.
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

  // The definition is unchanged, and deliberately the same object: the tag, the
  // class, the template and the dependencies are exactly what a revision may not
  // move, so a caller holding the old definition still holds a true one.
  return previous;
}

/**
 * Refuse an edit a live page cannot adopt, naming what changed.
 *
 * Every rule here is a fact about an instance that already exists. A field, public
 * or private, is written by a constructor that cannot be run again on it; a
 * reactive property is an accessor pair and an observed-attribute list the registry
 * snapshotted at `define` time; a base class, a template and a `uses` entry are
 * identity rather than behaviour. What is left is the prototype and the statics,
 * and those are what `adoptClassBody` moves.
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
 * Lit reads `static properties` once, at `finalize`, and turns each entry into an
 * accessor on the prototype and an entry in the observed-attribute list the
 * registry snapshotted. Neither can be redone for a class already registered, so a
 * changed declaration is a reload.
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
 * Answered by building one element from each rather than by reading source, which
 * is the only way to see what an initialiser actually produces. Both are
 * constructed as the registered tag — `Reflect.construct` with the registered class
 * as `new.target` is what makes the fresh class constructible at all, since a class
 * the registry does not hold throws on `super()` — and neither is ever inserted
 * into the document.
 *
 * Names first: a field the edit added would be `undefined` on every element that
 * already exists, and on every element created afterwards too, because the
 * constructor that installs it is not the one the registry holds. Then primitive
 * values, because a changed initialiser is an edit whose effect a live page can
 * never show. Anything else — a signal, a resource, an object — is left alone: its
 * identity differs between any two instances, so it says nothing about the edit.
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
    // A constructor that will not run outside the document cannot be compared, and
    // an unreadable answer is a reload.
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
 * Move an edited class body onto the class the registry holds.
 *
 * Own members only, on both sides: what a base class contributes is reached through
 * the prototype chain and was never this class's to replace. A member the edit
 * deleted is deleted here, so a method that is gone is gone rather than lingering
 * from the definition before it.
 *
 * Declared reactive properties are skipped in both directions. Their prototype
 * entries are the accessor pairs Lit generated at `finalize`, each reading a
 * storage key of its own, and replacing one with the fresh class's would leave
 * every live host's value behind it.
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

  // `CustomElementConstructor` declares its prototype as `any`, so the class is
  // narrowed and the prototype read off that rather than cast at every use below.
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

  // Statics are copied and never deleted: a class carries `prototype`, `length` and
  // `name` of its own, and the registered one also carries the bookkeeping Lit
  // wrote at `finalize`. The edited class has neither, so what it does have is
  // exactly what its author wrote.
  for (const key of Reflect.ownKeys(fresh)) {
    if (key === 'prototype' || key === 'length' || key === 'name') continue;
    const descriptor = Object.getOwnPropertyDescriptor(fresh, key);
    if (descriptor !== undefined) Object.defineProperty(registered, key, descriptor);
  }
}

/**
 * Ask every live host of a replaced class to render.
 *
 * The document is walked rather than a registry of hosts kept, for the reason
 * template.js gives: a registry costs an entry on every connect and disconnect in
 * every page, production included, to serve an event that only happens in
 * development. `instanceof` rather than the tag, so a component subclassed to tweak
 * behaviour renders too — it inherits the prototype that just changed.
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
 * A module URL with the revision query removed, and the same string when it has
 * none — so the ordinary path allocates nothing and compares by identity.
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
