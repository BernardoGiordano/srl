/**
 * What the project model knows, in one declaration.
 *
 * Three static tools need to know which custom elements exist and where their markup
 * is. Answering it separately, the template checker would use a TypeScript AST pass,
 * the verifier a line-anchored regex and the template bundler a directory walk. Three
 * answers to one question is three chances to disagree, and a regex cannot see a
 * definition written across two lines while an AST pass can. These types are the one
 * answer, and `cli/project-model/index.mjs` is the only thing that produces them.
 */

import type { Diagnostic } from '../diagnostics/types.js';

/** An application: a repository-root directory with an index.html. */
export interface Application {
  name: string;
  dir: string;
  /**
   * Marked `.private`, which excludes it from the generated tables in README.md and
   * from nothing else. See `apps()` in cli/layout.mjs.
   */
  private?: boolean;
}

/** How a tag came to exist. */
export type DefinitionKind = 'defineComponent' | 'customElements.define';

/** One entry of a definition's `uses` list, resolved as the browser resolves it. */
export interface UsesEntry {
  /** The class name as written in `uses`. */
  className: string;
  /** The module the import brought it from, or the declaring module for a local class. */
  module: string | null;
  /** The tag that class defines, or null when nothing in the project defines one. */
  tag: string | null;
}

/** One source declaration retained after Element semantics are resolved. */
export interface ElementDeclaration {
  /** Absolute path of the module containing the declaration. */
  module: string;
  className: string;
  /** 1-based source position of the declared name. */
  line: number;
  column: number;
}

/** One Lit reactive declaration, including meaning inherited by an element. */
export interface ElementProperty {
  name: string;
  /** Input is caller-authored; state belongs only to the declaring element. */
  kind: 'input' | 'state' | 'unknown';
  /** Observed attribute name, false when disabled, null when statically unknown. */
  attribute: string | false | null;
  declaration: ElementDeclaration;
}

/** Detail shape recoverable without inventing a second JavaScript type system. */
export type ElementEventDetail =
  | { kind: 'none' }
  | { kind: 'property'; name: string }
  | { kind: 'object'; properties: string[] }
  | { kind: 'type'; text: string }
  | { kind: 'unknown' };

/** One event an element dispatches itself. Native DOM events remain platform facts. */
export interface ElementEvent {
  name: string;
  event: 'Event' | 'CustomEvent';
  detail: ElementEventDetail;
  declaration: ElementDeclaration;
}

/** One custom element, as the project statically declares it. */
export interface ElementRecord {
  tag: string;
  className: string;
  /** Absolute path of the module holding the declaration. */
  module: string;
  /** Whether the class is exported, which decides whether a shim can import it. */
  exported: boolean;
  kind: DefinitionKind;
  /**
   * Absolute path of the markup this element renders, or null when it declares
   * `template: false` or was registered by a bare `customElements.define`.
   */
  template: string | null;
  /** True when the declaration wrote a `template` key, false when the sibling applies. */
  templateDeclared: boolean;
  /** Whether `template` names a file that exists. Null when there is no template. */
  templateExists: boolean | null;
  /**
   * Absolute path of the module's sibling `.css` when the declaration writes
   * `styles: true`, and null otherwise. ADR-0119.
   */
  stylesheet: string | null;
  /** Whether `stylesheet` exists. Null when there is no stylesheet. */
  stylesheetExists: boolean | null;
  uses: UsesEntry[];
  /** Tags this element's markup may name, from `uses` and its own tag. Sorted. */
  usesTags: string[];
  /** Known public input names from resolved `static properties`. Sorted. */
  properties: string[];
  /** Known internal reactive state names. Sorted. */
  state: string[];
  /** Resolved declarations, inherited ones included and subclass overrides applied. */
  propertyDeclarations: ElementProperty[];
  /** False when inheritance or a declaration contains meaning static analysis cannot read. */
  surfaceKnown: boolean;
  /**
   * Attribute names an instance reacts to, from `static properties` and
   * `static observedAttributes`. Sorted.
   *
   * Null when the declaration could not be read, which is not the same as empty. An
   * element that observes nothing is `[]`, and only `[]` licenses a tool to call an
   * attribute written in markup dead.
   */
  observedAttributes: string[] | null;
  /** Known dispatched events, inherited ones included. */
  events: ElementEvent[];
  /** False when at least one dispatched event name is computed. */
  eventsKnown: boolean;
  /** Projection buckets from `<x-content>`. Empty string is default; null means dynamic. */
  slots: string[] | null;
}

/** A template file on disk and who claims it. */
export interface TemplateRecord {
  /** Absolute path. */
  path: string;
  /** The URL the browser fetches it at for this application, or null if unreachable. */
  url: string | null;
  /** The tag whose definition claims it, or null for an unclaimed file. */
  claimedBy: string | null;
  /** True for a file under a `test/` directory: a fixture, never an application asset. */
  fixture: boolean;
}

/** A name templates may use without importing anything, via `registerTemplateGlobals`. */
export interface TemplateGlobal {
  module: string;
  exportName: string;
}

/**
 * Something the static model cannot understand, or a project rule it can see broken,
 * before it becomes a `Diagnostic` with a `project/` code.
 *
 * `project/dynamic` matters most. A declaration built at runtime works in the browser
 * and is invisible to every tool here, so the model reports it rather than skipping it.
 *
 * An `error` fails verification and the build. A `warning` covers two cases. One is
 * dynamism that is the mechanism itself, such as the `customElements.define` inside
 * `defineComponent`. The other is a test that declares something invalid on purpose,
 * to assert that the runtime rejects it. Failing the build on either would mean
 * deleting the framework's own code to satisfy a tool that reads it.
 */
export interface ModelFinding {
  code:
    | 'project/dynamic'
    | 'project/duplicate-tag'
    | 'project/unresolved-uses'
    | 'project/shadowed-lifecycle'
    | 'project/stylesheet-without-template'
    | 'project/shared-stylesheet'
    | 'project/stylesheet-scope';
  severity: 'error' | 'warning';
  /** Absolute path of the file the finding is about. */
  file: string;
  message: string;
  /** 1-based, when the finding is about one declaration rather than the file. */
  line?: number;
  /** 1-based. Present only alongside `line`. */
  column?: number;
}

/** One reference to `localStorage` or `sessionStorage`, as an expression rather than text. */
export interface StorageAccess {
  name: 'localStorage' | 'sessionStorage' | string;
  /** 1-based line, so a diagnostic can name the line the caller has to open. */
  line: number;
}

/** One JavaScript module, as parsed. */
export interface ModuleRecord {
  path: string;
  /** Local name -> absolute path of the module it was imported from. */
  imports: Map<string, string>;
  /**
   * Absolute paths of the modules imported for their side effect alone.
   *
   * A component declares the components it renders in `uses`. A plain custom element
   * cannot be declared that way, because `uses` resolves to component definitions and
   * throws on a class that has none. Importing its module is the whole of its
   * declaration, and this is where the template checker reads it.
   */
  sideEffectImports: Set<string>;
  /** Class name -> whether it is exported. */
  classes: Map<string, boolean>;
  /**
   * Every message this module names, in source order, such as `t('orders.title')`,
   * `t('cart.items', { count })`, `t('billing.view.' + name)` and
   * `standardText('table', 'empty')`.
   *
   * A reference site and nothing more. `key` is the whole key when it is written out.
   * Otherwise `prefix` is the part before the first computed piece, and the
   * reference
   * claims every catalog key under it. `params` is null when the options argument cannot
   * be read, which forbids any conclusion about placeholders.
   */
  messages: MessageReference[];
  /**
   * Every dotted string the module writes, and every dotted head of a template literal:
   * `labelKey: 'dashboard.panel.live'`, `` `audit.action.${entry.action}` ``.
   *
   * A key named outside a call, which is how a screen keeps its copy in a table and
   * resolves it later. Enough to say a catalog entry is still spoken for; never enough to
   * say a message exists.
   */
  literals: Set<string>;
  /**
   * Every place this module reaches for browser storage itself.
   *
   * Recorded because one module owns synchronous UI-preference storage, and a second
   * module reading `localStorage` directly is how an application that swaps the store
   * gets it swapped for some preferences and not others. A comment mentioning the word
   * is not a reference; `globalThis.localStorage` is.
   */
  storage: StorageAccess[];
}

/** Everything one application's source statically declares. */
export interface ProjectModel {
  app: Application;
  /** Import-map prefix -> absolute directory, for the prefixes that name source. */
  prefixes: Record<string, string>;
  /** Absolute path of the module index.html loads, or null if it names none. */
  entry: string | null;
  /** Every JavaScript module scanned, keyed by absolute path. */
  modules: Map<string, ModuleRecord>;
  /** Custom elements by tag. */
  elements: Map<string, ElementRecord>;
  /** Template globals by name. */
  globals: Map<string, TemplateGlobal>;
  /** Every template file this application can reach, keyed by absolute path. */
  templates: Map<string, TemplateRecord>;
  /** Every `ModelFinding`, as a `Diagnostic` grouped under the application's name. */
  diagnostics: Diagnostic[];
}

/** One `t()` or `standardText()` call, as the parse read it. */
export interface MessageReference {
  /** The whole key, or null when the call computes part of it. */
  key: string | null;
  /** The static start of a computed key, or null when there is none. */
  prefix: string | null;
  /** Parameter names passed as an object literal; null when the argument is unreadable. */
  params: string[] | null;
  /** Whether `count` is among them, which is what selects a plural variant. */
  count: boolean;
  /** 1-based, at the key argument. */
  line: number;
  column: number;
}

/** The JSON projection: sorted, repository-relative, no absolute path anywhere. */
export interface ProjectIndex {
  app: string;
  root: string;
  entry: string | null;
  prefixes: Record<string, string>;
  elements: Array<{
    tag: string;
    className: string;
    module: string;
    exported: boolean;
    kind: DefinitionKind;
    template: string | null;
    stylesheet: string | null;
    uses: string[];
    properties: string[];
    state: string[];
    surfaceKnown: boolean;
    propertyDeclarations: Array<{
      name: string;
      kind: 'input' | 'state' | 'unknown';
      attribute: string | false | null;
      module: string;
      className: string;
      line: number;
      column: number;
    }>;
    observedAttributes: string[] | null;
    events: Array<{
      name: string;
      event: 'Event' | 'CustomEvent';
      detail: ElementEventDetail;
      module: string;
      className: string;
      line: number;
      column: number;
    }>;
    eventsKnown: boolean;
    slots: string[] | null;
  }>;
  globals: Array<{ name: string; module: string; exportName: string }>;
  templates: Array<{ path: string; url: string | null; claimedBy: string | null }>;
  diagnostics: Array<{
    code: string;
    severity: string;
    file: string | null;
    line: number | null;
    column: number | null;
    message: string;
  }>;
}
