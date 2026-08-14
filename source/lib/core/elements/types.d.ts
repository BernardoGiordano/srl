/**
 * What a component is, and what one request to mount a view carries.
 *
 * `@core/elements/component.js` records definitions, `mount.js` performs a
 * request, and `outlet.js` turns a target into one.
 */

/**
 * What `defineComponent` is given: one component's identity, stated once.
 *
 * The template is not named here. It is the sibling `.html` of `module`, so a
 * renamed component module cannot leave a template URL pointing at the old name.
 */
export interface ComponentSpec {
  /** Custom element name. Lowercase, hyphenated, and this component's only one. */
  readonly tag: string;
  /** The class to register. */
  readonly element: CustomElementConstructor;
  /** Always `import.meta.url`: the anchor for the template and for error messages. */
  readonly module: string;
  /**
   * `false` for a component that builds its markup in `render()`, or a path
   * relative to `module` when the template is not its sibling.
   */
  readonly template?: string | false;
  /**
   * The components this component's template may name, as classes. A real import,
   * so ES module evaluation order defines them first, and the fact
   * tools/template-check.mjs checks the template against.
   */
  readonly uses?: readonly ComponentRef[];
}

/** One component's identity, as `defineComponent` recorded it. */
export interface ComponentDefinition {
  readonly tag: string;
  readonly element: CustomElementConstructor;
  readonly module: string;
  /** Compiled template URL, or undefined for a component that renders in JavaScript. */
  readonly templateUrl: string | undefined;
  readonly uses: readonly ComponentDefinition[];
}

/**
 * Anything that names a component: its class, its definition, or its tag.
 *
 * A route, an `<x-outlet>` target, a remote entry and the startup root all take
 * one of these, so none of them repeats a tag string that already exists in the
 * component's own definition. `tagOf` in `@core/elements/component.js` reads the tag back
 * out.
 */
export type ComponentRef = string | CustomElementConstructor | ComponentDefinition;

/** What a `<x-outlet>` should be showing. */
export interface OutletTarget {
  /** Component to mount: its class, its definition, or its tag. */
  readonly tag?: ComponentRef;
  /**
   * Loads the module that defines it. Awaited once, before mounting. What it
   * resolves to is read as a `ComponentRef` when `tag` is not given.
   */
  readonly load?: () => Promise<unknown>;
  /** Assigned as element *properties*, not attributes, so objects survive. */
  readonly props?: Readonly<Record<string, unknown>>;
}

/** Buckets of light-DOM content, keyed by slot name. `''` is the default slot. */
export type ContentBuckets = Map<string, Node[]>;

/**
 * One request to mount a view: what defines it, what instantiates it, and what
 * releases it if the attempt is superseded before its element is placed.
 *
 * An `<x-outlet>` target, one level of a matched route chain and a remote's root
 * are all expressed as one of these, which is what lets `@core/elements/mount.js` own the
 * load, definition, race and release rules for all three instead of each of them
 * owning its own copy.
 */
export interface MountRequest {
  /**
   * The caller, as it appears at the front of every error message from this
   * request: `<x-outlet>`, `Route "/users"`, `Remote "billing"`.
   */
  readonly where: string;
  /**
   * Component to instantiate, and what a `create` result is validated against:
   * its class, its definition, or its tag.
   */
  readonly tag?: ComponentRef;
  /**
   * Loads the module that defines it. Run only while `tag` is undefined or names
   * an element that does not exist yet. What it resolves to is read as a
   * `ComponentRef` when `tag` is not given, which is how a lazy route learns what
   * it is mounting from the module it just loaded.
   */
  readonly load?: () => Promise<unknown>;
  /**
   * Builds the element itself, for a mount that also owns something external to
   * it: a route's `mount()`, a remote's `mount(host)`. Takes precedence over
   * instantiating `tag`.
   */
  readonly create?: () => HTMLElement | Promise<HTMLElement>;
  /** Assigned as element *properties*, not attributes, so objects survive. */
  readonly props?: Readonly<Record<string, unknown>>;
  /** Pairs with `create` when the element is discarded before it is placed. */
  readonly release?: (element: HTMLElement) => void | Promise<void>;
}
