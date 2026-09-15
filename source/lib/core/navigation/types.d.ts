/**
 * The route table, route matches and guard contracts.
 */

import type { ComponentRef } from '@core/elements/types.js';

/** What the router knows about the URL it just matched. */
export interface RouteMatch {
  /**
   * The leaf route that renders the page. Inside a guard, the level whose guard is
   * running.
   */
  readonly route: RouteDef;
  /** Root to leaf, one entry per nesting level. */
  readonly chain: readonly RouteDef[];
  /** Path parameters, already percent-decoded. Deeper levels win a name clash. */
  readonly params: Readonly<Record<string, string>>;
  readonly pathname: string;
  readonly query: URLSearchParams;
}

/**
 * A guard. Return `true` to allow the navigation, or a path to redirect to.
 *
 * `false` isn't allowed. A blocked navigation that stays put leaves the URL and the
 * view disagreeing, so every denial names a destination such as `'/login'`.
 */
export type RouteGuard = (match: RouteMatch) => true | string | Promise<true | string>;

/** What a `canDeactivate` guard is told about the level it is being asked to release. */
export interface DeactivateContext {
  /** The route being left. */
  readonly route: RouteDef;
  /**
   * The mounted element, which gives the guard access to screen state, such as
   * `element instanceof CustomerEditPage && element.form.dirty.value`. Null for a
   * componentless parent.
   */
  readonly element: HTMLElement | null;
  /** Where the user is going. Null when the router is being detached. */
  readonly to: RouteMatch | null;
}

/**
 * Asked before a level is released, deepest first. Return `false` to stay, like
 * Angular's `CanDeactivate`.
 *
 * `false` is allowed here, unlike in `RouteGuard`. Refusing to leave has an obvious
 * destination, the current screen, and the router restores its URL.
 */
export type DeactivateGuard = (context: DeactivateContext) => boolean | Promise<boolean>;

/** One entry in the route table. Angular's `Route`. */
export interface RouteDef {
  /**
   * `/users`, `/users/:id`, `/billing/*`, or `*` for a catch-all. A child's path is
   * relative to its parent's, and `''` matches the parent's URL.
   */
  readonly path: string;
  /**
   * Component to mount, as a class, definition or tag. Omit it when `load` resolves
   * the component, when `redirect` or `mount` is set, or on a componentless parent
   * that only adds a path prefix and a guard.
   */
  readonly component?: ComponentRef;
  /**
   * Loads the component's module on first match. Resolve it to the class, as in
   * `() => import('@app/pages/users-page.js').then((m) => m.UsersPage)`, and omit
   * `component`.
   */
  readonly load?: () => Promise<unknown>;
  /** Create one route-owned element. Used when mounting also owns external resources. */
  readonly mount?: () => HTMLElement | Promise<HTMLElement>;
  /** Release resources associated with an element created by `mount`. */
  readonly unmount?: (element: HTMLElement) => void | Promise<void>;
  /** Unconditional redirect target. */
  readonly redirect?: string;
  readonly canActivate?: RouteGuard;
  /**
   * Asked only when this level is actually released. A layout that survives its
   * children changing isn't asked, and neither is a parameter change that re-renders
   * in place.
   */
  readonly canDeactivate?: DeactivateGuard;
  /**
   * Child routes, rendered into this route's `<x-route-outlet>`. A parent never
   * matches alone, so give it a child with `path: ''` to render at its own URL.
   */
  readonly children?: readonly RouteDef[];
}

/**
 * One leaf of the route tree, with its compiled path pattern and its chain of routes.
 * Internal to the router, and free to change shape.
 */
export interface CompiledRoute {
  /** Root to leaf. The last entry is the route that renders the page. */
  readonly chain: readonly RouteDef[];
  readonly regex: RegExp;
  /** Capture-group names in order, parent levels first. */
  readonly names: string[];
}
