/**
 * Component definitions and mount requests.
 *
 * `@core/elements/component.js` records definitions, `mount.js` performs requests,
 * and `outlet.js` turns a target into a request.
 */

/**
 * What `defineComponent` receives. The template is the sibling `.html` of `module`.
 */
export interface ComponentSpec {
  /** Custom element name, lowercase and hyphenated. */
  readonly tag: string;
  /** The class to register. */
  readonly element: CustomElementConstructor;
  /** Always `import.meta.url`. Anchors the template and names the file in errors. */
  readonly module: string;
  /**
   * `false` for a component that renders in `render()`, or a path relative to
   * `module` when the template isn't its sibling.
   */
  readonly template?: string | false;
  /**
   * `true` when the sibling `.css` of `module` is this Element's stylesheet. Its rules
   * reach the markup this Element's template renders, and the Element itself through
   * `:host`. ADR-0119.
   *
   * The production build writes `'bundled'` when the scoped rules are already in the
   * application stylesheet.
   */
  readonly styles?: boolean | 'bundled';
  /**
   * The components this template may name, as classes. The import defines them
   * first, and the template checker validates the template against this list.
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
  /** Whether its template stamps ownership for a stylesheet of its own. */
  readonly styled: boolean;
  /** The stylesheet this page fetched, or undefined when unstyled or bundled. */
  readonly stylesheetUrl: string | undefined;
  readonly uses: readonly ComponentDefinition[];
}

/**
 * Anything that names a component: its class, its definition or its tag.
 * `tagOf` in `@core/elements/component.js` reads the tag.
 */
export type ComponentRef = string | CustomElementConstructor | ComponentDefinition;

/** What a `<x-outlet>` should be showing. */
export interface OutletTarget {
  /** Component to mount: its class, its definition or its tag. */
  readonly tag?: ComponentRef;
  /**
   * Loads the module that defines the component, once, before mounting. Its result
   * is read as a `ComponentRef` when `tag` is absent.
   */
  readonly load?: () => Promise<unknown>;
  /** Assigned as element properties, so objects survive. */
  readonly props?: Readonly<Record<string, unknown>>;
}

/** Buckets of light-DOM content, keyed by slot name. `''` is the default slot. */
export type ContentBuckets = Map<string, Node[]>;

/**
 * One request to mount a view. Outlet targets, route levels and remote roots all
 * become one of these.
 */
export interface MountRequest {
  /**
   * The caller's name at the front of every error message, such as `<x-outlet>`,
   * `Route "/users"` or `Remote "billing"`.
   */
  readonly where: string;
  /** Component to create, and what a `create` result is checked against. */
  readonly tag?: ComponentRef;
  /**
   * Loads the defining module. Runs only when `tag` is absent or not yet defined. Its
   * result is read as a `ComponentRef` when `tag` is absent.
   */
  readonly load?: () => Promise<unknown>;
  /**
   * Builds the element directly, for a mount that also owns something else, such as
   * a route's `mount()` or a remote's `mount(host)`. Takes precedence over `tag`.
   */
  readonly create?: () => HTMLElement | Promise<HTMLElement>;
  /** Assigned as element properties, so objects survive. */
  readonly props?: Readonly<Record<string, unknown>>;
  /** Releases an element from `create` that was discarded before placement. */
  readonly release?: (element: HTMLElement) => void | Promise<void>;
}
