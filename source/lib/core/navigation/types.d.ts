/**
 * The route table, what a match knows, and what a guard is asked.
 */

import type { ComponentRef } from '@core/elements/types.js';

/** What the router knows about the URL it just matched. */
export interface RouteMatch {
  /**
   * The route this match concerns: the leaf that renders the page, or — inside a
   * guard — the level of the chain whose guard is running.
   */
  readonly route: RouteDef;
  /**
   * Root to leaf, one entry per level of nesting. A route with no `children`
   * anywhere above it matches as a chain of one.
   */
  readonly chain: readonly RouteDef[];
  /** Path parameters, already percent-decoded. Deeper levels win a name clash. */
  readonly params: Readonly<Record<string, string>>;
  readonly pathname: string;
  readonly query: URLSearchParams;
}

/**
 * A guard. Return `true` to allow navigation, or a path to redirect to.
 *
 * Collapsing allow and redirect into one return value removes the second "and
 * where do we send them instead" field that a boolean guard always needs.
 *
 * Note that `false` is not permitted, deliberately. Angular's guards may return
 * false to block navigation and stay put, which leaves the URL and the rendered
 * view disagreeing until something reconciles them. Requiring a destination means
 * every denial lands somewhere the user can see, and `'/login'` or `'/forbidden'`
 * is what a boolean guard was going to be paired with anyway.
 */
export type RouteGuard = (match: RouteMatch) => true | string | Promise<true | string>;

/** What a `canDeactivate` guard is told about the level it is being asked to release. */
export interface DeactivateContext {
  /** The route being left. */
  readonly route: RouteDef;
  /**
   * The mounted element, which is how a guard reaches the screen's own state —
   * `element instanceof CustomerEditPage && element.form.dirty.value`. Null for a
   * componentless parent, which has nothing to ask.
   */
  readonly element: HTMLElement | null;
  /** Where the user is going. Null when the router is being detached. */
  readonly to: RouteMatch | null;
}

/**
 * Asked before a level is released, deepest first, and answered `false` to stay
 * put. Angular's `CanDeactivate`.
 *
 * `false` is permitted here where `RouteGuard` refuses it, and the asymmetry is
 * deliberate rather than an oversight. Refusing to *enter* leaves the question
 * "then where?" unanswered, which is why `RouteGuard` requires a destination.
 * Refusing to *leave* answers it by construction: the destination is the screen
 * the user is already looking at, and the URL is put back to match it.
 */
export type DeactivateGuard = (context: DeactivateContext) => boolean | Promise<boolean>;

/** One entry in the route table. Angular's `Route`. */
export interface RouteDef {
  /**
   * `/users`, `/users/:id`, `/billing/*`, or `*` for a catch-all. A child route's
   * path is relative to its parent's, and `''` matches the parent's own URL.
   */
  readonly path: string;
  /**
   * Component to mount, as its class, its definition or its tag. Omit when
   * `load` resolves it, when `redirect` or `mount` is set, or when `children` is:
   * a parent with no component of its own is Angular's componentless route,
   * contributing a path prefix and a guard and nothing else.
   */
  readonly component?: ComponentRef;
  /**
   * Loads the component's module, on first match only. Resolve it to the class —
   * `() => import('@app/pages/users-page.js').then((m) => m.UsersPage)`, Angular's
   * `loadComponent` — and the route needs no `component` of its own.
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
   * Asked before this level is released, and only when it is actually being
   * released: a layout that survives its children changing is never asked, and a
   * parameter change that re-renders in place is not a deactivation.
   */
  readonly canDeactivate?: DeactivateGuard;
  /**
   * Child routes, rendered into this route's `<x-route-outlet>` and outliving
   * each other's navigations. A parent is never matched on its own: give it a
   * child with `path: ''` when its own URL must render something.
   */
  readonly children?: readonly RouteDef[];
}

/**
 * One leaf of the route tree, with its full path pattern compiled and the chain
 * of routes that leads to it.
 *
 * Internal to the router: nothing exported from `@core/navigation/router.js` accepts or
 * returns one, and the functions that build them are private to that file. It is
 * stated here rather than in the module because a regex-per-leaf is not the
 * shape matching has to keep.
 */
export interface CompiledRoute {
  /** Root to leaf. The last entry is the route that renders the page. */
  readonly chain: readonly RouteDef[];
  readonly regex: RegExp;
  /** Capture-group names in order, parent levels first. */
  readonly names: string[];
}
