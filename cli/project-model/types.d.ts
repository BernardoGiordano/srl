/**
 * What the project model knows, in one declaration.
 *
 * Every static tool in tools/ used to answer "which custom elements exist and where is
 * their markup" for itself: the template checker with a TypeScript AST pass, the
 * verifier with a line-anchored regex, the template bundler with a directory walk. Three
 * answers to one question is three chances to disagree, and the regex could not see a
 * definition written across two lines while the AST pass could. These types are the one
 * answer, and `cli/project-model/index.mjs` is the only thing that produces them.
 */

/** An application: a repository-root directory with an index.html. */
export interface Application {
  name: string;
  dir: string;
  /**
   * Marked `.private`: excluded from the generated tables in README.md and from
   * nothing else. See `apps()` in cli/layout.mjs.
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
   * Null when the declaration could not be read, which is not the same as empty: an
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
 * Something the static model cannot understand, or a project rule it can see broken.
 *
 * `dynamic` is the one that matters most: a declaration built at runtime works in the
 * browser and is invisible to every tool here, so it has to be reported rather than
 * skipped.
 *
 * Severity is what makes that reportable without being useless. An `error` fails
 * verification. A `note` is dynamism that is either the mechanism itself — the
 * `customElements.define` inside `defineComponent`, the projection marker registering
 * itself — or a test deliberately declaring something invalid to assert that the runtime
 * rejects it. Failing the build on those would mean deleting the framework's own
 * implementation to satisfy a tool that reads it.
 */
export interface ProjectDiagnostic {
  kind: 'dynamic' | 'duplicate-tag' | 'unresolved-uses' | 'unreadable' | 'shadowed-lifecycle';
  severity: 'error' | 'note';
  /** Absolute path of the file the diagnostic is about. */
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
   * A component declares the components it renders in `uses`. A plain custom
   * element cannot be declared that way — `uses` resolves to component definitions
   * and throws on a class that has none — so importing its module is the whole of
   * its declaration, and this is where the template checker reads it.
   */
  sideEffectImports: Set<string>;
  /** Class name -> whether it is exported. */
  classes: Map<string, boolean>;
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
  diagnostics: ProjectDiagnostic[];
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
    kind: string;
    severity: string;
    file: string;
    line: number | null;
    column: number | null;
    message: string;
  }>;
}
