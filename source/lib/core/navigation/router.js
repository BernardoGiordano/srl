import { defineComponent } from '@core/elements/component.js';
import { defineElementDefault } from '@core/elements/element-defaults.js';
import { MountSequence, createElement } from '@core/elements/mount.js';
import { whenRendered } from '@core/elements/settled.js';
import { signal } from '@core/foundation/reactive.js';

/** @import { MountAttempt } from '@core/elements/mount.js' */
/** @import { MountRequest } from '@core/elements/types.js' */
/** @import { CompiledRoute, RouteDef, RouteMatch } from '@core/navigation/types.js' */

/**
 * Client-side router with path parameters, wildcards, guards, redirects, lazy
 * loading, link interception and history integration.
 *
 * Mounting lives in `@core/elements/mount.js`, shared with `<x-outlet>` and the
 * remote loader. This file handles matching, guards, redirects, the frame chain and
 * which `<x-route-outlet>` each level renders into.
 *
 * `attachRouter` is the interface an application uses. A navigation completes as a
 * promise and fails as state.
 *
 * A navigation settles as one transaction. Every entering level is built before
 * anything is torn down, so what is published always matches what is mounted.
 * ADR-0002.
 */

/* ── Navigation state, as signals ──────────────────────────────────────── */

/** Path parameters for the active route. Angular's `ActivatedRoute.params`. */
export const routeParams = signal(/** @type {Readonly<Record<string, string>>} */ ({}));

/** Parsed query string. Angular's `ActivatedRoute.queryParams`. */
export const queryParams = signal(new URLSearchParams(location.search));

/** Active pathname. Read this to mark navigation links active. */
export const currentPath = signal(location.pathname);

/** True while a navigation is resolving, including any lazy module fetch. */
export const isNavigating = signal(false);

/**
 * Why the latest navigation failed, or null when it succeeded.
 *
 * Failure is state, because a link click and the back button have no caller to
 * reject. ADR-0003. A successful navigation clears it, so it always describes the
 * URL on screen. The entry navigation also rejects `attachRouter`.
 */
export const navigationError = signal(/** @type {Error | null} */ (null));

/* ── The child outlet ──────────────────────────────────────────────────── */

const ROUTE_OUTLET_TAG = 'x-route-outlet';

/**
 * `<x-route-outlet>` marks where a layout route renders its active child, like
 * Angular's `<router-outlet>`. The child renders inside the marker, so clearing it
 * can't disturb the layout's own markup. The router fills it directly.
 */
export class RouteOutlet extends HTMLElement {}

/**
 * `display: contents`, because a route outlet usually sits inside the flex or grid
 * container that positions the page, and a wrapper box would break that layout. The
 * rule sorts below Tailwind's utilities, so a class on the outlet still wins.
 * ADR-0119.
 */
defineElementDefault(ROUTE_OUTLET_TAG, 'display:contents');

// The tag is a literal, because the template checker reads
// `defineComponent({ tag: '...' })` statically and wouldn't see a constant.
//
// A layout template lists `RouteOutlet` in `uses`. `template: false`, because the
// router fills the element.
await defineComponent({
  tag: 'x-route-outlet',
  element: RouteOutlet,
  module: import.meta.url,
  template: false,
});

/* ── Path patterns ─────────────────────────────────────────────────────── */

/*
 * Matching is private to this file. Callers only see which route answered, so the
 * list of regular expressions can become an index or a trie without changing them.
 */

/**
 * Compile a path pattern to a regular expression.
 *
 *   /users            literal
 *   /users/:id        one named parameter, matching a single segment
 *   /billing/*        prefix match, remainder captured as `rest`
 *   *                 catch-all, for the not-found route
 *
 * A trailing slash always matches, so `/users` and `/users/` are the same route.
 *
 * @param {string} pattern
 * @returns {{ regex: RegExp, names: string[] }}
 */
function compilePath(pattern) {
  /** @type {string[]} */
  const names = [];
  let source = '';

  for (const segment of pattern.split('/')) {
    if (segment === '') continue;

    if (segment === '*') {
      names.push('rest');
      // Optional, so `/billing/*` also matches `/billing`.
      source += '(?:/(.*))?';
    } else if (segment.startsWith(':')) {
      names.push(segment.slice(1));
      source += '/([^/]+)';
    } else {
      source += `/${escapeRegExp(segment)}`;
    }
  }

  return { regex: new RegExp(`^${source}/?$`, 'u'), names };
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Flatten a route tree into one compiled matcher per leaf, each carrying its chain of
 * routes from the root. Flattening once at configuration time keeps "first match
 * wins" literal.
 *
 * A child's path joins its parent's, so `/settings` plus `users` matches
 * `/settings/users`, and a child path of `''` matches the parent's URL. A parameter
 * name repeated across levels resolves to the deepest one.
 *
 * Configuration errors throw here, inside `attachRouter`, so an unreachable tree fails
 * at startup.
 *
 * @param {readonly RouteDef[]} routes
 * @param {string} [prefix]
 * @param {readonly RouteDef[]} [ancestors]
 * @returns {CompiledRoute[]}
 */
function flattenRoutes(routes, prefix = '', ancestors = []) {
  /** @type {CompiledRoute[]} */
  const flattened = [];

  for (const route of routes) {
    const chain = [...ancestors, route];
    const pattern = `${prefix}/${route.path}`;
    const children = route.children ?? [];

    if (children.length === 0) {
      flattened.push({ chain, ...compilePath(pattern) });
      continue;
    }

    if (route.redirect !== undefined) {
      throw new Error(
        `Route "${route.path}" has both \`children\` and \`redirect\`. A parent that ` +
          `redirects can never render a child; put the redirect on a child whose path is "".`,
      );
    }
    if (route.path.split('/').includes('*')) {
      throw new Error(
        `Route "${route.path}" has \`children\` behind a wildcard. The wildcard consumes the ` +
          `rest of the path, so none of them could ever match.`,
      );
    }

    flattened.push(...flattenRoutes(children, pattern, chain));
  }

  return flattened;
}

/* ── Router ────────────────────────────────────────────────────────────── */

const MAX_REDIRECTS = 10;

/**
 * One mounted level of the active chain. `element` is null for a componentless
 * grouping route, which adds a prefix and a guard and renders nothing.
 *
 * @typedef {{ route: RouteDef, element: HTMLElement | null }} ActiveFrame
 */

/**
 * One level that is built but not yet placed. The request travels with it because it
 * holds `release`, which an abandoned level still needs.
 *
 * @typedef {{ route: RouteDef, request: MountRequest, element: HTMLElement | null }} EnteringLevel
 */

/**
 * The state a navigation may publish, captured before it starts. It holds the route
 * signals and the href of the mounted chain. ADR-0002.
 *
 * Params must be published before the component that reads them is created, so the
 * updates can't all happen at once. Staging lets them roll back together.
 *
 * `mutated` marks the first DOM change. After it the old view is gone, so a failure
 * is reported against the destination.
 *
 * @typedef {{
 *   params: Readonly<Record<string, string>>,
 *   query: URLSearchParams,
 *   path: string,
 *   committed: string,
 *   mutated: boolean,
 * }} StagedNavigation
 */

/**
 * The router. Applications and tests reach it through `RouterAttachment`, which also
 * owns outlet readiness and navigation completion.
 */
class AppRouter {
  #outlet;

  /** @type {CompiledRoute[]} */
  #compiled = [];

  /**
   * Discards stale navigations, so a slow lazy import can't mount after the user
   * moved on. Navigation and mounting share one sequence, because a superseded
   * navigation and a superseded mount are the same event.
   */
  #sequence = new MountSequence();

  /**
   * The mounted chain, root first, with one frame per route level. Going from
   * `/settings/users` to `/settings/roles` replaces only the second frame.
   *
   * @type {ActiveFrame[]}
   */
  #frames = [];

  /**
   * The full href of the mounted chain, as published. A rollback restores it, and
   * the query string matters because it can hold a table's filter state. Empty until
   * the first navigation commits.
   */
  #committed = '';

  #listeners = new AbortController();

  /**
   * The operation in flight, either a navigation or a `stop` teardown. It never
   * rejects, because its outcome already went to `navigationError`.
   *
   * @type {Promise<void>}
   */
  #pending = Promise.resolve();

  /** @param {HTMLElement} outlet */
  constructor(outlet) {
    this.#outlet = outlet;
  }

  /**
   * @param {readonly RouteDef[]} routes
   */
  setRoutes(routes) {
    this.#compiled = flattenRoutes(routes);
  }

  /**
   * Start listening and resolve the current URL.
   *
   * Rejects when this first navigation fails, because an application whose entry URL
   * doesn't resolve hasn't started.
   *
   * @returns {Promise<void>}
   */
  async start() {
    const { signal: abort } = this.#listeners;

    window.addEventListener('popstate', () => void this.#dispatch(currentHref(), false), {
      signal: abort,
    });

    // One delegated listener, so every `<a href>` works, including links rendered
    // later.
    document.addEventListener('click', (event) => this.#onClick(event), { signal: abort });

    await this.#dispatch(currentHref(), false);
  }

  /** Detach listeners and release the whole active chain. */
  stop() {
    this.#sequence.cancel();
    this.#listeners.abort();
    this.#listeners = new AbortController();

    // Tracked like a navigation, so `settled` covers teardown and a throwing
    // `unmount` hook gets published.
    void this.#remember(this.#deactivateFrom(0));
  }

  /**
   * Resolve when nothing is in flight. It loops, so a navigation that starts while
   * waiting, such as a guard's redirect, is covered too.
   *
   * @returns {Promise<void>}
   */
  async settled() {
    for (let awaited = null; awaited !== this.#pending; ) {
      awaited = this.#pending;
      await awaited;
    }
  }

  /**
   * Resolves when the navigation has settled, whether or not it succeeded. See
   * `navigationError`.
   *
   * @param {string} href
   * @param {{ replace?: boolean }} [options]
   * @returns {Promise<void>}
   */
  async navigate(href, options) {
    const url = new URL(href, location.origin);
    if (url.origin !== location.origin) {
      location.assign(url.href);
      return;
    }

    const target = url.pathname + url.search + url.hash;
    if (options?.replace === true) history.replaceState(null, '', target);
    else history.pushState(null, '', target);

    void this.#dispatch(target, true);
    await this.settled();
  }

  /**
   * Start a navigation and make it the operation in flight.
   *
   * Returns the navigation itself, so `start` can reject with it. The tracked copy
   * handles the rejection, so voiding this in a `popstate` listener is safe.
   *
   * @param {string} href
   * @param {boolean} isPush
   * @returns {Promise<void>}
   */
  #dispatch(href, isPush) {
    return this.#remember(this.#resolve(href, isPush));
  }

  /**
   * Track `work` as the operation in flight and publish its outcome.
   *
   * Only the newest operation publishes. A superseded navigation can still fail
   * later, and that failure must not describe the current view.
   *
   * @param {Promise<void>} work
   * @returns {Promise<void>} `work` itself, now carrying a rejection handler
   */
  #remember(work) {
    const outcome = work.then(
      () => {
        if (this.#pending === outcome) navigationError.value = null;
      },
      (cause) => {
        if (this.#pending === outcome) navigationError.value = asError(cause);
      },
    );
    this.#pending = outcome;
    return work;
  }

  /**
   * @param {MouseEvent} event
   */
  #onClick(event) {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    // `composedPath` also finds anchors inside third-party shadow roots.
    const anchor = event
      .composedPath()
      .find(
        (node) => node instanceof HTMLAnchorElement && node.hasAttribute('href'),
      );
    if (!(anchor instanceof HTMLAnchorElement)) return;

    if (anchor.hasAttribute('download')) return;
    if (anchor.relList.contains('external')) return;
    if (anchor.target !== '' && anchor.target !== '_self') return;
    if (anchor.dataset.routerIgnore !== undefined) return;

    const url = new URL(anchor.href, location.origin);
    if (url.origin !== location.origin) return;

    // A fragment change on the current page stays with the browser, so in-page
    // anchors keep working.
    if (url.pathname === location.pathname && url.search === location.search && url.hash !== '') {
      return;
    }

    event.preventDefault();
    void this.navigate(url.pathname + url.search + url.hash);
  }

  /**
   * @param {string} href
   * @param {boolean} isPush
   * @returns {Promise<void>}
   */
  async #resolve(href, isPush) {
    const attempt = this.#sequence.begin();

    // Stage before asking or publishing anything, so every early exit rolls back to
    // one prior state.
    const staged = this.#stage();
    isNavigating.value = true;

    try {
      let target = href;

      // Frames that already agreed to be left during this navigation. A redirect hop
      // checks the chain again, and one click must not prompt twice.
      /** @type {Set<ActiveFrame>} */
      const cleared = new Set();

      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const url = new URL(target, location.origin);
        const match = this.#match(url);

        // Ask about leaving before entering, fetching or tearing down, because a
        // screen that refuses to be left must see nothing happen. A URL that matches
        // nothing releases the whole chain, so it asks too.
        //
        // Await only when some frame has a guard. Awaiting a plain `true` still costs
        // a microtask, and route tables without `canDeactivate` shouldn't pay it.
        const mayLeave = this.#mayLeave(match, attempt, cleared);
        if (mayLeave !== true && !(await mayLeave)) {
          if (!attempt.live) return;
          // The URL already moved, because `navigate` pushed or the back button
          // popped, so restore the staged URL. Nothing else was published yet. After
          // a refused back the history stack stays slightly off, because
          // `history.go(1)` would race the popstate it triggers.
          this.#rollback(staged);
          return;
        }
        if (!attempt.live) return;

        if (match === null) {
          // Release before publishing the URL, so the empty screen and the route
          // state agree.
          if (this.#frames.length > 0) staged.mutated = true;
          await this.#deactivateFrom(0);
          if (!attempt.live) return;
          publish(url, {});
          this.#committed = url.pathname + url.search + url.hash;
          return;
        }

        if (match.route.redirect !== undefined) {
          target = match.route.redirect;
          history.replaceState(null, '', target);
          continue;
        }

        // Guards run parent to child on every navigation, including levels already
        // mounted. A scope guard must still refuse when scopes change inside its
        // section, and a parent's verdict comes before a child's module is fetched.
        const verdict = await this.#authorize(match, attempt);
        if (!attempt.live) return;
        if (verdict !== true) {
          target = verdict;
          history.replaceState(null, '', target);
          continue;
        }

        // Publish before creating the component, so its first render sees the right
        // params. `staged` lets a render that never reaches the screen roll this back.
        publish(url, match.params);
        this.#committed = url.pathname + url.search + url.hash;

        await this.#render(match, attempt, staged);
        if (!attempt.live) return;

        if (isPush && url.hash === '') window.scrollTo({ top: 0 });
        return;
      }

      throw new Error(`Redirect loop while resolving ${href}.`);
    } catch (cause) {
      // Roll back only while the staged state still matches the screen. Once the old
      // chain is released there's nothing to return to, and a superseded attempt must
      // not touch its successor's state.
      if (attempt.live && !staged.mutated) this.#rollback(staged);
      throw cause;
    } finally {
      if (attempt.live) isNavigating.value = false;
    }
  }

  /**
   * Capture what this navigation may publish, so it can be rolled back as one.
   *
   * @returns {StagedNavigation}
   */
  #stage() {
    return {
      params: routeParams.value,
      query: queryParams.value,
      path: currentPath.value,
      committed: this.#committed,
      mutated: false,
    };
  }

  /**
   * Restore the route state and the URL to the mounted chain.
   *
   * Uses `replaceState` instead of `history.back()`, which would race its popstate. A
   * failed push therefore leaves one extra history entry holding the URL on screen.
   *
   * @param {StagedNavigation} staged
   */
  #rollback(staged) {
    // Nothing was ever committed, so this is the entry navigation, which fails by
    // rejecting `attachRouter`.
    if (staged.committed === '') return;

    routeParams.value = staged.params;
    queryParams.value = staged.query;
    currentPath.value = staged.path;
    this.#committed = staged.committed;
    history.replaceState(null, '', staged.committed);
  }

  /**
   * @param {URL} url
   * @returns {RouteMatch | null}
   */
  #match(url) {
    for (const { chain, regex, names } of this.#compiled) {
      const result = regex.exec(url.pathname);
      if (result === null) continue;

      /** @type {Record<string, string>} */
      const params = {};
      names.forEach((name, index) => {
        const value = result[index + 1];
        if (value !== undefined) params[name] = decodeURIComponent(value);
      });

      // `route` is the leaf, the route that renders the page.
      const route = chain[chain.length - 1];
      if (route === undefined) continue;

      return { route, chain, params, pathname: url.pathname, query: url.searchParams };
    }
    return null;
  }

  /**
   * Ask each level about to be released whether it may go.
   *
   * Levels are asked deepest first, in release order, so a tab is asked before the
   * screen that holds it.
   *
   * Only departing levels are asked. `#retainedDepth` matches `#render`, so a layout
   * that survives its children changing isn't asked, and `/users/1` to `/users/2`
   * re-renders without asking anyone.
   *
   * @param {RouteMatch | null} match Null when the URL matches nothing, which
   *   releases every level.
   * @param {MountAttempt} attempt
   * @param {Set<ActiveFrame>} cleared Frames that already said yes this navigation.
   * @returns {true | Promise<boolean>} `true` synchronously when no level has a guard,
   *   which avoids a microtask. The promise also resolves false for a superseded
   *   attempt, so the caller checks `attempt.live` first.
   */
  #mayLeave(match, attempt, cleared) {
    const retained = match === null ? 0 : this.#retainedDepth(match.chain);
    const leaving = this.#frames
      .slice(retained)
      .reverse()
      .filter((frame) => frame.route.canDeactivate !== undefined && !cleared.has(frame));

    return leaving.length === 0 ? true : this.#askToLeave(leaving, match, attempt, cleared);
  }

  /**
   * @param {readonly ActiveFrame[]} leaving Deepest first.
   * @param {RouteMatch | null} match
   * @param {MountAttempt} attempt
   * @param {Set<ActiveFrame>} cleared
   * @returns {Promise<boolean>}
   */
  async #askToLeave(leaving, match, attempt, cleared) {
    for (const frame of leaving) {
      const allowed = await frame.route.canDeactivate?.({
        route: frame.route,
        element: frame.element,
        to: match,
      });
      if (!attempt.live) return false;
      if (allowed !== true) return false;

      // Remember the answer, so a redirect hop doesn't ask the same question again.
      cleared.add(frame);
    }
    return true;
  }

  /**
   * Run every guard on the matched chain, parent first.
   *
   * @param {RouteMatch} match
   * @param {MountAttempt} attempt
   * @returns {Promise<true | string>}
   */
  async #authorize(match, attempt) {
    for (const route of match.chain) {
      if (route.canActivate === undefined) continue;

      // Each guard learns which level it guards, so one function can serve a parent
      // and a child.
      const verdict = await route.canActivate({ ...match, route });
      if (!attempt.live) return true;
      if (verdict !== true) return verdict;
    }
    return true;
  }

  /**
   * Mount the matched chain, keeping levels that are already mounted.
   *
   * It runs in two phases, which together form the transaction. First every entering
   * level is built while the old screen still shows. Then the outgoing chain is
   * released and the new one placed. Rejected imports, modules that don't define
   * their element and throwing `mount()` calls all fail in the first phase, while the
   * navigation can still roll back.
   *
   * @param {RouteMatch} match
   * @param {MountAttempt} attempt
   * @param {StagedNavigation} staged
   * @returns {Promise<void>}
   */
  async #render(match, attempt, staged) {
    const { chain } = match;
    const retained = this.#retainedDepth(chain);

    // The whole chain is already mounted, so only params or a remote's sub-path
    // changed. Each level re-renders from its signals, which keeps scroll, focus and
    // component state, as in Angular.
    if (retained === chain.length) return;

    const entering = await this.#prepare(chain.slice(retained), attempt);
    if (entering === null) return;

    await this.#place(entering, retained, attempt, staged);
  }

  /**
   * Build every entering level before anything on screen changes.
   *
   * Building touches no DOM. `@core/elements/mount.js` creates elements without
   * connecting them, so a child can be built before its parent is placed. Levels
   * build in parallel, so a nested URL costs one round trip instead of one per level.
   * `#place` handles ordering at commit. `#authorize` already ran in sequence,
   * because a parent's verdict decides whether a child is fetched.
   *
   * Returns null when the navigation was superseded mid-load, after releasing
   * whatever it built.
   *
   * @param {readonly RouteDef[]} entering Levels below the retained depth, root first.
   * @param {MountAttempt} attempt
   * @returns {Promise<EnteringLevel[] | null>}
   */
  async #prepare(entering, attempt) {
    const staging = entering.map(async (route, index) => {
      const request = requestFor(route);
      const element = await this.#instantiate(route, request, index === entering.length - 1);
      return /** @type {EnteringLevel} */ ({ route, request, element });
    });

    // `allSettled`, so a failed level doesn't leave a sibling built and unreleased,
    // and no rejection goes unhandled.
    const settled = await Promise.allSettled(staging);

    /** @type {EnteringLevel[]} */
    const prepared = [];
    /** @type {{ cause: unknown } | null} */
    let failure = null;

    for (const result of settled) {
      if (result.status === 'fulfilled') {
        prepared.push(result.value);
        continue;
      }
      // Report the shallowest failure, since a broken parent explains a broken child.
      failure ??= { cause: result.reason };
    }

    if (failure !== null) {
      // The built levels will never be placed, so release them now and run each
      // route's `unmount`.
      await releaseAll(prepared);
      throw failure.cause;
    }

    if (!attempt.live) {
      await releaseAll(prepared);
      return null;
    }

    return prepared;
  }

  /**
   * Release the outgoing chain and place the prepared levels.
   *
   * The navigation's first DOM change happens here, and `staged` records it. After
   * that, restoring the URL would describe a screen that is gone.
   *
   * @param {readonly EnteringLevel[]} entering
   * @param {number} retained
   * @param {MountAttempt} attempt
   * @param {StagedNavigation} staged
   * @returns {Promise<void>}
   */
  async #place(entering, retained, attempt, staged) {
    if (this.#frames.length > retained) {
      staged.mutated = true;

      try {
        await this.#deactivateFrom(retained);
      } catch (cause) {
        // A throwing `unmount` still removed the old chain, so the navigation can't
        // roll back or continue. Release the built levels before the failure is
        // published.
        await releaseAll(entering);
        throw cause;
      }

      if (!attempt.live) {
        await releaseAll(entering);
        return;
      }
    }

    for (const [index, level] of entering.entries()) {
      const { route, request, element } = level;

      /** @type {HTMLElement} */
      let container;
      try {
        // A layout without `<x-route-outlet>` fails here, after its own level is on
        // screen, because the outlet only exists once the layout renders.
        container = await this.#containerFor(retained + index);
      } catch (cause) {
        await releaseAll(entering.slice(index));
        throw cause;
      }

      staged.mutated = true;
      if (!(await attempt.place(container, element, request))) {
        await releaseAll(entering.slice(index + 1));
        return;
      }

      this.#frames.push({ route, element });
    }
  }

  /**
   * How many leading levels of `chain` are already mounted. Levels compare by route
   * identity, so a layout survives its children changing.
   *
   * @param {readonly RouteDef[]} chain
   * @returns {number}
   */
  #retainedDepth(chain) {
    let depth = 0;
    for (const frame of this.#frames) {
      if (chain[depth] !== frame.route) break;
      depth += 1;
    }
    return depth;
  }

  /**
   * Create one level's element, or null for a componentless parent that only adds a
   * prefix and a guard. A leaf that names nothing is a misconfiguration.
   *
   * @param {RouteDef} route
   * @param {MountRequest} request
   * @param {boolean} isLeaf
   * @returns {Promise<HTMLElement | null>}
   */
  async #instantiate(route, request, isLeaf) {
    const element = await createElement(request);
    if (element !== null || !isLeaf) return element;
    throw new Error(`Route "${route.path}" resolved to no component and has no redirect.`);
  }

  /**
   * Where the level at `depth` renders. The root level uses the router's outlet, and
   * deeper levels use the `<x-route-outlet>` of the nearest ancestor with an element.
   * Componentless levels are skipped, so their children render in the grandparent's
   * outlet.
   *
   * @param {number} depth
   * @returns {Promise<HTMLElement>}
   */
  async #containerFor(depth) {
    for (const frame of this.#frames.slice(0, depth).reverse()) {
      if (frame.element === null) continue;
      return await outletIn(frame.element, frame.route);
    }
    return this.#outlet;
  }

  /**
   * Release the levels at `depth` and below, deepest first, so a child goes before
   * its layout.
   *
   * @param {number} depth
   * @returns {Promise<void>}
   */
  async #deactivateFrom(depth) {
    while (this.#frames.length > depth) {
      const frame = this.#frames.pop();
      if (frame === undefined) return;

      // The frame is popped before the await, so an interleaving navigation never
      // sees a frame that is being released.
      try {
        if (frame.element !== null) await frame.route.unmount?.(frame.element);
      } finally {
        frame.element?.remove();
      }
    }
  }
}

/**
 * The child outlet inside one layout element.
 *
 * Waits for the element's first render, since the outlet doesn't exist before it. A
 * layout's outlet is an ancestor of any deeper one, so the first match is this
 * level's.
 *
 * @param {HTMLElement} element
 * @param {RouteDef} route
 * @returns {Promise<HTMLElement>}
 */
async function outletIn(element, route) {
  await whenRendered(element);

  const outlet = element.querySelector(ROUTE_OUTLET_TAG);
  if (!(outlet instanceof HTMLElement)) {
    throw new Error(
      `Route "${route.path}" renders <${element.localName}>, which contains no ` +
        `<${ROUTE_OUTLET_TAG}>. A route with \`children\` needs one to render them into, ` +
        `and it must not be inside an *if that can remove it.`,
    );
  }
  return outlet;
}

/**
 * Release levels that were built and will never be placed, deepest first.
 *
 * @param {readonly EnteringLevel[]} levels
 * @returns {Promise<void>}
 */
async function releaseAll(levels) {
  for (let index = levels.length - 1; index >= 0; index -= 1) {
    const level = levels[index];
    if (level === undefined || level.element === null) continue;
    await level.request.release?.(level.element);
  }
}

/**
 * One route level as a mount request.
 *
 * A route without `component` may still resolve its class through `load`, so a lazy
 * route never names its element twice.
 *
 * @param {RouteDef} route
 * @returns {MountRequest}
 */
function requestFor(route) {
  return {
    where: `Route "${route.path}"`,
    tag: route.component,
    load: route.load,
    create: route.mount,
    release: route.unmount,
  };
}

/**
 * @param {URL} url
 * @param {Readonly<Record<string, string>>} params
 */
function publish(url, params) {
  // A new params object each time, so subscribers always notify.
  routeParams.value = { ...params };
  queryParams.value = url.searchParams;
  currentPath.value = url.pathname;
}

/** @returns {string} */
function currentHref() {
  return location.pathname + location.search + location.hash;
}

/**
 * @param {unknown} cause
 * @returns {Error}
 */
function asError(cause) {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/* ── Attachment ────────────────────────────────────────────────────────── */

/**
 * The default outlet selector. `<main>` is also the landmark screen readers announce
 * as the page's main content.
 */
const DEFAULT_OUTLET = 'main';

/**
 * @typedef {object} AttachOptions
 * @property {string} [outlet] Selector for the element inside the host that
 *   routed views render into. Defaults to `main`.
 */

/**
 * The attachment `navigate()` and `navigationSettled()` use.
 *
 * There is one per document, because two routers would both claim a link click.
 * `attachRouter` sets it synchronously, so a component that navigates early waits
 * for attaching to finish.
 *
 * @type {RouterAttachment | null}
 */
let attached = null;

/**
 * A router attached to one shell, created by `attachRouter`.
 *
 * `navigate` and `settled` resolve when the navigation settles, so tests never wait
 * on a timer.
 */
export class RouterAttachment {
  /** @type {AppRouter | null} */
  #router = null;

  /** @type {HTMLElement | null} */
  #outlet = null;

  #stopped = false;

  /** @type {Promise<void>} */
  #started;

  /**
   * @param {HTMLElement} host
   * @param {readonly RouteDef[]} routes
   * @param {string} selector
   */
  constructor(host, routes, selector) {
    this.#started = this.#begin(host, routes, selector);
  }

  /**
   * Resolves once the entry URL is on screen. Rejects when attaching failed, because
   * the host had no outlet or the first navigation couldn't resolve.
   *
   * @returns {Promise<void>}
   */
  get started() {
    return this.#started;
  }

  /**
   * The element the top route level renders into. Null until attaching resolves it.
   *
   * @returns {HTMLElement | null}
   */
  get outlet() {
    return this.#outlet;
  }

  /**
   * Navigate, resolving when the navigation settles. `navigationError` says whether
   * it succeeded.
   *
   * @param {string} href
   * @param {{ replace?: boolean }} [options]
   * @returns {Promise<void>}
   */
  async navigate(href, options) {
    const router = await this.#ready();
    await router?.navigate(href, options);
  }

  /**
   * Resolve when attaching and any navigation under it are done.
   *
   * @returns {Promise<void>}
   */
  async settled() {
    const router = await this.#ready();
    await router?.settled();
  }

  /**
   * Stop listening, tear down the mounted chain and stop being the attachment the
   * module-level functions use. Safe to call before attaching finishes.
   */
  stop() {
    this.#stopped = true;
    this.#router?.stop();
    if (attached === this) attached = null;
  }

  /**
   * @param {HTMLElement} host
   * @param {readonly RouteDef[]} routes
   * @param {string} selector
   * @returns {Promise<void>}
   */
  async #begin(host, routes, selector) {
    const outlet = await outletOf(host, selector);
    if (this.#stopped) return;

    const router = new AppRouter(outlet);
    router.setRoutes(routes);
    this.#router = router;
    this.#outlet = outlet;

    await router.start();
  }

  /**
   * The router once attaching finishes, or null when attaching failed or was stopped.
   * `attachRouter` has already reported that failure.
   *
   * @returns {Promise<AppRouter | null>}
   */
  async #ready() {
    await this.#started.catch(() => undefined);
    return this.#router;
  }
}

/**
 * Attach the router to a shell and resolve its entry URL.
 *
 * Pass the shell element, whose own markup contains the outlet. This waits for the
 * shell's render, finds the outlet, compiles the routes and starts listening. It
 * rejects when there is no outlet or the entry URL doesn't resolve.
 *
 * @param {HTMLElement} host
 * @param {readonly RouteDef[]} routes
 * @param {AttachOptions} [options]
 * @returns {Promise<RouterAttachment>}
 */
export async function attachRouter(host, routes, options) {
  // Stop the previous attachment first, so two routers never answer the same click.
  attached?.stop();

  const attachment = new RouterAttachment(host, routes, options?.outlet ?? DEFAULT_OUTLET);
  attached = attachment;

  try {
    await attachment.started;
  } catch (cause) {
    // `start` already added the document listeners, so release them.
    attachment.stop();
    throw cause;
  }
  return attachment;
}

/**
 * Navigate. Resolves when the view is mounted or a guard's redirect has resolved. It
 * never rejects, because `navigationError` holds the outcome, so an event handler can
 * `void` it.
 *
 * Throws synchronously when no router is attached, which is a misuse.
 *
 * @param {string} href
 * @param {{ replace?: boolean }} [options]
 * @returns {Promise<void>}
 */
export function navigate(href, options) {
  return requireAttachment().navigate(href, options);
}

/**
 * Resolve when the attached router has nothing in flight. Use it to wait for
 * navigations no caller holds a promise for, such as link clicks and the back button.
 *
 * @returns {Promise<void>}
 */
export function navigationSettled() {
  return requireAttachment().settled();
}

/**
 * @returns {RouterAttachment}
 */
function requireAttachment() {
  if (attached === null) {
    throw new Error(
      'No router is attached. A shell attaches one from `onMount` with ' +
        '`attachRouter(this, routes)`; this ran before that, or after `stop()`.',
    );
  }
  return attached;
}

/**
 * The element inside `host` that the router renders into.
 *
 * Waits for the host's render first. In a shell's `onMount`, a projecting layout may
 * not have put `<main>` back yet, and the router would silently never start.
 *
 * @param {HTMLElement} host
 * @param {string} selector
 * @returns {Promise<HTMLElement>}
 */
async function outletOf(host, selector) {
  await whenRendered(host);

  const outlet = host.querySelector(selector);
  if (!(outlet instanceof HTMLElement)) {
    throw new Error(
      `<${host.localName}> renders no element matching "${selector}", so the router has ` +
        `nowhere to mount routed views. The outlet belongs in the shell's own template, and ` +
        `must not be inside an *if that can remove it.`,
    );
  }
  return outlet;
}

/**
 * Wrap a predicate as a guard, like Angular's `canActivate`.
 *
 * @param {() => boolean | Promise<boolean>} allowed
 * @param {string} redirectTo
 * @returns {NonNullable<RouteDef['canActivate']>}
 */
export function guard(allowed, redirectTo) {
  return async () => ((await allowed()) ? true : redirectTo);
}
