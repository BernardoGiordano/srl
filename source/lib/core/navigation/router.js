import { defineComponent } from '@core/elements/component.js';
import { defineElementDefault } from '@core/elements/element-defaults.js';
import { MountSequence, createElement } from '@core/elements/mount.js';
import { whenRendered } from '@core/elements/settled.js';
import { signal } from '@core/foundation/reactive.js';

/** @import { MountAttempt } from '@core/elements/mount.js' */
/** @import { MountRequest } from '@core/elements/types.js' */
/** @import { CompiledRoute, RouteDef, RouteMatch } from '@core/navigation/types.js' */

/**
 * Client-side router: path parameters, wildcards, guards, redirects, lazy
 * component loading, link interception and history integration.
 *
 * It does not own mounting. Loading a level's module, checking that it defined
 * the element it names, instantiating it, abandoning a navigation whose module
 * resolved after the user moved on, and releasing an element that lost that race
 * all live in `@core/elements/mount.js`, which `<x-outlet>` and the remote loader
 * cross too. What is left here is routing: matching, guards, redirects, the frame
 * chain, and which `<x-route-outlet>` a level renders into.
 *
 * `attachRouter` is the whole interface an application crosses. How a URL is
 * matched is private to this file: completion is a promise, failure is state.
 *
 * A navigation settles as one transaction — everything entering is built before
 * anything is torn down, so what is published is always what is mounted. ADR-0002.
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
 * State rather than a rejection: a link click and the back button have no caller
 * to reject at. ADR-0003. Cleared when a navigation succeeds, so it always
 * describes the URL on screen. The entry navigation is the exception — it is part
 * of attaching, so its failure also rejects `attachRouter`.
 */
export const navigationError = signal(/** @type {Error | null} */ (null));

/* ── The child outlet ──────────────────────────────────────────────────── */

const ROUTE_OUTLET_TAG = 'x-route-outlet';

/**
 * `<x-route-outlet>` marks where a layout route renders its active child.
 * Angular's `<router-outlet>`, except that the child is rendered *inside* the
 * marker rather than after it, so one element owns the whole slot and clearing it
 * cannot disturb the layout's own markup.
 *
 * A plain `HTMLElement` with no behaviour: the router owns its children
 * imperatively, exactly as it owns the root outlet it is handed.
 */
export class RouteOutlet extends HTMLElement {}

/**
 * `display: contents` for the same reason `<x-content>` has it, and it matters
 * more here: a route outlet almost always sits inside the flex or grid container
 * that positions the page. An inline-by-default wrapper between that container
 * and the page component would silently break every layout utility applied to it.
 *
 * A default, not a rule: it sorts below Tailwind's utilities, so any class an
 * application puts on the outlet wins if it wants a real box. ADR-0001.
 */
defineElementDefault(ROUTE_OUTLET_TAG, 'display:contents');

// The tag is spelled out here rather than passed as the constant, because
// cli/checks/template-check.mjs reads `defineComponent({ tag: '...' })` calls
// statically. Through a variable the checker would not learn the tag exists and
// would report `<x-route-outlet>` in every layout template as an unknown element.
//
// A layout template must list `RouteOutlet` in its `uses`, exactly as it lists any
// other element it names. `template: false`: the router fills this element
// imperatively.
await defineComponent({
  tag: 'x-route-outlet',
  element: RouteOutlet,
  module: import.meta.url,
  template: false,
});

/* ── Path patterns ─────────────────────────────────────────────────────── */

/*
 * Matching is private implementation. Nothing outside this file reaches
 * `compilePath` or `flattenRoutes`, and no caller can see how a URL was matched —
 * only which route answered. That is what leaves a flat list of regular
 * expressions free to become a segment index or a trie when a measured cost says
 * so, with no caller updated and no test rewritten.
 */

/**
 * Compile a path pattern to a regular expression.
 *
 * Supported syntax, kept small on purpose:
 *   /users            literal
 *   /users/:id        one named parameter, matching a single segment
 *   /billing/*        prefix match, remainder captured as `rest`
 *   *                 catch-all, for the not-found route
 *
 * A trailing slash is always tolerated, because `/users` and `/users/` being
 * different routes has never once been what anyone wanted.
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
      // Optional group, so `/billing/*` matches `/billing` as well as
      // `/billing/invoices`. Without this every prefix route needs a second
      // entry for its own root.
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
 * Flatten a route tree into one compiled matcher per leaf, each carrying the
 * chain of routes from the root down to itself.
 *
 * Flattened here rather than descended per navigation, which is what keeps "first
 * match wins" meaning what it says. ADR-0004.
 *
 * A child's path is joined to its parent's, so `/settings` plus `users` matches
 * `/settings/users` and a child path of `''` matches the parent's own URL.
 * Duplicate parameter names across levels resolve to the deepest one.
 *
 * The two configuration errors below throw here, which is at route installation
 * and therefore inside `attachRouter`: a tree a URL could never reach is reported
 * to whoever attached it, at startup, rather than at the first navigation that
 * quietly finds nothing.
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
 * grouping route, which contributes a prefix and a guard and renders nothing.
 *
 * @typedef {{ route: RouteDef, element: HTMLElement | null }} ActiveFrame
 */

/**
 * One level that has been built and not yet placed: its route, the request that
 * built it, and the element that request produced — null for a componentless
 * grouping level, exactly as in `ActiveFrame`.
 *
 * The request is carried rather than rebuilt because it holds `release`, and a
 * level that is prepared and then abandoned still has to be torn down.
 *
 * @typedef {{ route: RouteDef, request: MountRequest, element: HTMLElement | null }} EnteringLevel
 */

/**
 * Everything one navigation may publish, as it was before that navigation
 * started: the route signals, and the href the mounted chain belongs to.
 *
 * The params have to be published before the component that reads them is
 * created, so the several mutations cannot happen at one instant. Staging them is
 * what makes the sequence one transaction anyway. ADR-0002.
 *
 * `mutated` records the first DOM change of the navigation. From that point the
 * outgoing view no longer exists, so there is nothing coherent to return to and
 * the failure is reported against the destination instead.
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
 * The router itself. Not exported: an application and a test both reach it
 * through `RouterAttachment`, so the interface they cross is the one that owns
 * outlet readiness and navigation completion rather than the one below it.
 */
class AppRouter {
  #outlet;

  /** @type {CompiledRoute[]} */
  #compiled = [];

  /**
   * Guards against interleaved navigations. A slow lazy import must not mount its
   * view after the user has already navigated somewhere else.
   *
   * The same sequence `@core/elements/mount.js` uses for mounting, shared with navigation
   * on purpose: "this navigation has been superseded" and "this mount has been
   * superseded" are one fact, and a second counter for it is how a guard that
   * resolves late gets to publish a URL nobody asked for.
   */
  #sequence = new MountSequence();

  /**
   * The mounted chain, root first. One entry per level of the matched route, so
   * `[settings-layout, settings-users]` is two frames and navigating to
   * `/settings/roles` replaces only the second.
   *
   * @type {ActiveFrame[]}
   */
  #frames = [];

  /**
   * The href the mounted chain belongs to, exactly as it was published.
   *
   * The whole href rather than `currentPath`, because putting a URL back is what
   * reads it — a refused `canDeactivate` and a navigation that failed before it
   * changed the screen — and putting back the path without the query string
   * silently drops a table's filter state.
   *
   * Empty until the first navigation commits, which is the one case with nothing
   * to return to.
   */
  #committed = '';

  #listeners = new AbortController();

  /**
   * The operation in flight: a navigation, or the teardown `stop` started. Never
   * rejects — its outcome has already been published to `navigationError` — so
   * `settled` is a completion signal and nothing else.
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
   * Begin listening and resolve the current URL.
   *
   * Rejects when that first navigation fails, unlike every later one: attaching
   * asked for it and is holding the promise, and an application whose entry URL
   * does not resolve has not started.
   *
   * @returns {Promise<void>}
   */
  async start() {
    const { signal: abort } = this.#listeners;

    window.addEventListener('popstate', () => void this.#dispatch(currentHref(), false), {
      signal: abort,
    });

    // One delegated listener rather than per-link wiring, so plain `<a href>`
    // works in every template including ones rendered after this point.
    document.addEventListener('click', (event) => this.#onClick(event), { signal: abort });

    await this.#dispatch(currentHref(), false);
  }

  /** Detach listeners and release the whole active chain. */
  stop() {
    this.#sequence.cancel();
    this.#listeners.abort();
    this.#listeners = new AbortController();

    // Remembered like a navigation, so `settled` covers a teardown too: an
    // `unmount` hook that throws on the way out is published rather than lost in
    // a promise nobody holds.
    void this.#remember(this.#deactivateFrom(0));
  }

  /**
   * Resolve when nothing is in flight.
   *
   * Loops rather than awaiting once, so a navigation that started while this was
   * waiting is covered as well: a guard's redirect and a click that lands during
   * one are a single settle from the outside.
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
   * The returned promise is the navigation itself, so `start` can reject with it;
   * the remembered one carries the outcome to `navigationError` and stops there,
   * which is what makes `void`-ing this at a `popstate` safe rather than an
   * unhandled rejection.
   *
   * @param {string} href
   * @param {boolean} isPush
   * @returns {Promise<void>}
   */
  #dispatch(href, isPush) {
    return this.#remember(this.#resolve(href, isPush));
  }

  /**
   * Remember `work` as the operation in flight and publish its outcome.
   *
   * Only the newest operation may publish. A navigation that lost a race can
   * still fail afterwards — its lazy module rejects long after the user moved on —
   * and the failure of a view nobody is looking at must not describe the one that
   * is.
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

    // composedPath so clicks originating inside a shadow root still find the
    // anchor. Nothing here uses shadow DOM today, but a third-party component
    // might, and the failure mode would be a link that silently full-reloads.
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

    // A pure fragment change on the current page is the browser's job; taking it
    // over would break in-page anchors.
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

    // Staged before anything is asked or published, so every early exit below —
    // a refusing `canDeactivate`, a guard that throws, a lazy module that
    // rejects, a redirect loop — has one prior state to return to rather than
    // its own idea of what to undo.
    const staged = this.#stage();
    isNavigating.value = true;

    try {
      let target = href;

      // Which frames have already answered "yes, you may leave me" during this
      // navigation. A redirect hop re-examines the chain, and a screen asked
      // twice about one click would prompt twice.
      /** @type {Set<ActiveFrame>} */
      const cleared = new Set();

      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const url = new URL(target, location.origin);
        const match = this.#match(url);

        // Leaving is asked about before entering, and before anything is fetched
        // or torn down: a screen that refuses to be left has not been left, so
        // nothing about the attempted destination may have happened yet. A URL
        // that matches nothing releases the whole chain, so it is asked too.
        //
        // The verdict is awaited only when there is something to ask. `await` on
        // a plain `true` still costs a microtask, and a route table with no
        // `canDeactivate` anywhere in it — which is most of them — must not have
        // its timing changed by a feature it does not use.
        const mayLeave = this.#mayLeave(match, attempt, cleared);
        if (mayLeave !== true && !(await mayLeave)) {
          if (!attempt.live) return;
          // The URL moved before this ran — `navigate` pushes, and a back button
          // has already popped — so the staged state is put back, which for a
          // refusal is the URL alone: nothing has been published yet. The history
          // *stack* is left slightly wrong after a refused back, and that is the
          // accepted cost: the alternative is `history.go(1)`, which races the
          // popstate it triggers.
          this.#rollback(staged);
          return;
        }
        if (!attempt.live) return;

        if (match === null) {
          // Released before the URL is published, so the empty screen and the
          // route state it describes never disagree.
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

        // Guards run parent to child, and on every navigation rather than only on
        // the levels being newly mounted. A section guarded by `requireScope` must
        // still say no when the user's scopes change while they are inside it, and
        // the parent's answer is needed before a child's lazy module is fetched.
        const verdict = await this.#authorize(match, attempt);
        if (!attempt.live) return;
        if (verdict !== true) {
          target = verdict;
          history.replaceState(null, '', target);
          continue;
        }

        // Published before the component is created, so its very first render
        // already sees the right params. Publishing afterwards would make every
        // detail page render once with stale or empty parameters. It is `staged`
        // that keeps this from being a commit: a render that never reaches the
        // screen takes the published state back with it.
        publish(url, match.params);
        this.#committed = url.pathname + url.search + url.hash;

        await this.#render(match, attempt, staged);
        if (!attempt.live) return;

        if (isPush && url.hash === '') window.scrollTo({ top: 0 });
        return;
      }

      throw new Error(`Redirect loop while resolving ${href}.`);
    } catch (cause) {
      // Only while the staged state still describes what is on screen. Once the
      // outgoing chain has been released there is no view to return to, and a
      // superseded attempt must not touch state the navigation that replaced it
      // already owns.
      if (attempt.live && !staged.mutated) this.#rollback(staged);
      throw cause;
    } finally {
      if (attempt.live) isNavigating.value = false;
    }
  }

  /**
   * Stage a navigation: remember everything it may publish, so that it can be
   * taken back as one.
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
   * Put the route state and the URL back to the chain that is mounted.
   *
   * The URL goes back by `replaceState` rather than `history.back()`, for the
   * reason a refused `canDeactivate` does it: going back races the popstate it
   * triggers. A failed navigation that pushed therefore leaves one extra history
   * entry, holding the URL that is on screen.
   *
   * @param {StagedNavigation} staged
   */
  #rollback(staged) {
    // Nothing has ever been committed, so there is no screen to return to: this
    // is the entry navigation, which fails by rejecting `attachRouter`. Restoring
    // signals to values that were never on screen would only invent a third
    // state for an application that has not started.
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

      // `route` is the leaf: the route that renders the page, and the one a
      // consumer of `RouteMatch` means when it says "the current route".
      const route = chain[chain.length - 1];
      if (route === undefined) continue;

      return { route, chain, params, pathname: url.pathname, query: url.searchParams };
    }
    return null;
  }

  /**
   * Ask every level that is about to be released whether it may be.
   *
   * Deepest first, which is the order `#deactivateFrom` releases in and the order
   * that matters: a tab inside a detail screen is asked before the screen that
   * owns it, so the specific question reaches the user before the general one.
   *
   * Only levels that are genuinely going are asked. `#retainedDepth` is the same
   * calculation `#render` uses, so a layout surviving its children changing is
   * not asked, and `/users/1` to `/users/2` — a re-render, not a remount — asks
   * nobody. A screen that wants to guard a parameter change is guarding
   * something this router does not consider a navigation away.
   *
   * @param {RouteMatch | null} match Null when the URL matches nothing, which
   *   releases every level.
   * @param {MountAttempt} attempt
   * @param {Set<ActiveFrame>} cleared Frames that already said yes this navigation.
   * @returns {true | Promise<boolean>} `true` synchronously when nothing has a
   *   guard, which is the common case and must stay free of an extra microtask.
   *   False also when the attempt was superseded; the caller checks
   *   `attempt.live` before acting on it.
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

      // Remembered rather than recomputed, so a guard that asked the user a
      // question is not asked again by the redirect hop that follows.
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

      // The guard is told which level it is guarding, so one guard function can
      // serve a parent and a child and still report the right path.
      const verdict = await route.canActivate({ ...match, route });
      if (!attempt.live) return true;
      if (verdict !== true) return verdict;
    }
    return true;
  }

  /**
   * Mount the matched chain, keeping every level that is already there.
   *
   * Two phases, and the split is the transaction. Every entering level is built
   * first, while the screen is still the one the navigation started from, and
   * only then is the outgoing chain released and the new one placed. A lazy
   * import that rejects, a module that resolves without defining its element, a
   * `mount()` that throws — the failures a route table actually produces — all
   * happen in the first phase, where the navigation is still reversible.
   *
   * @param {RouteMatch} match
   * @param {MountAttempt} attempt
   * @param {StagedNavigation} staged
   * @returns {Promise<void>}
   */
  async #render(match, attempt, staged) {
    const { chain } = match;
    const retained = this.#retainedDepth(chain);

    // The whole chain is already mounted. Only params or a remote-owned sub-path
    // changed, and every level re-renders from the signals it read: /users/1 to
    // /users/2 is a re-render, not a remount, which is Angular's default and what
    // preserves scroll position, focus and component state.
    if (retained === chain.length) return;

    const entering = await this.#prepare(chain.slice(retained), attempt);
    if (entering === null) return;

    await this.#place(entering, retained, attempt, staged);
  }

  /**
   * Build every entering level, before anything on screen changes.
   *
   * Nothing here touches the DOM: loading a module, instantiating an element and
   * assigning its properties are all things a level can do while its predecessor
   * is still mounted. That a child is built before its parent is placed is safe
   * for the same reason — `@core/elements/mount.js` creates elements, it does not
   * connect them.
   *
   * Which is why the levels are staged together rather than one at a time: a
   * child's lazy `import()` no longer waits for its parent's module, its
   * templates and its element, so a URL's nesting depth costs one round trip
   * instead of one per level. Ordering is `#place`'s, at the commit, where
   * ADR-0002 puts it. `#authorize` stays a sequence for the opposite reason — a
   * parent's verdict decides whether a child is fetched at all — and it has
   * already run by the time a level reaches here.
   *
   * Returns null when the navigation was superseded while a module was loading,
   * having released whatever it had already built: an element that never reaches
   * the DOM still has to be paired with its `release`, which is what
   * `MountAttempt.keep` does for a single one.
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

    // `allSettled`, not `all`: a level that rejects while a sibling is still
    // loading must not leave that sibling's element unbuilt-and-unreleased, and
    // a rejection nobody awaits is an unhandled one.
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
      // The shallowest failure is the one reported, which is the one a sequential
      // walk would have reached first: a broken parent explains a broken child
      // better than the other way round.
      failure ??= { cause: result.reason };
    }

    if (failure !== null) {
      // The levels that did build will never be placed, so they are released here
      // rather than left to a garbage collector that cannot run a route's
      // `unmount`.
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
   * Release the outgoing chain and put the prepared levels on screen.
   *
   * The first DOM change of the navigation happens here, which is what `staged`
   * records: from this point the view the navigation started from is gone, so
   * putting the URL back would describe a screen that no longer exists.
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
        // An `unmount` hook that throws still leaves the chain it was releasing
        // gone, so this navigation cannot be undone and cannot continue. What is
        // left to keep whole is the pairing: the levels built for a chain that
        // will never be placed are released before the failure is published.
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
        // A layout that renders no `<x-route-outlet>` fails here, after its own
        // level is on screen: the outlet cannot be looked for until the element
        // that owns it has rendered.
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
   * How many leading levels of `chain` are mounted already.
   *
   * Route identity is the test, not the component tag: a layout must survive its
   * children changing, which is the entire reason to nest it.
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
   * Create one level's element, or null when the route is a componentless parent
   * that exists only to give its children a prefix and a guard.
   *
   * Loading, definition and validation belong to `@core/elements/mount.js`; what is left
   * here is the one route-level reading of "this names nothing": legal for a
   * grouping parent, a misconfiguration for a leaf.
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
   * Where the level at `depth` renders: the router's own outlet at the root, and
   * otherwise the `<x-route-outlet>` of the nearest ancestor level that has an
   * element. Componentless levels are transparent, so their children render in
   * their grandparent's outlet.
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
   * Release the levels at `depth` and below, deepest first, so a child is always
   * torn down before the layout it was rendering inside.
   *
   * @param {number} depth
   * @returns {Promise<void>}
   */
  async #deactivateFrom(depth) {
    while (this.#frames.length > depth) {
      const frame = this.#frames.pop();
      if (frame === undefined) return;

      // Popped before the await, so a navigation that interleaves with this
      // teardown cannot see a frame that is already being released.
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
 * The element's own render has to have happened first: it is created empty and
 * fills in on its first update, so the outlet does not exist until then.
 *
 * A layout's outlet is an ancestor of any deeper one, so the first match in
 * document order is always this level's own.
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
 * `MountAttempt.keep` pairs one element with its `release`; a staged chain needs
 * the same pairing for every level it built, in the order `#deactivateFrom`
 * releases a mounted chain in.
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
 * One route level, as `@core/elements/mount.js` sees it.
 *
 * A route with no `component` is not necessarily componentless: `load` may
 * resolve the class, which `@core/elements/mount.js` reads. That is what keeps a lazy
 * route from naming its element twice — once as a module path and once as a tag
 * string that has to match what the module happens to define.
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
  // New object identity every time, so subscribers always notify. Mutating the
  // existing params object would leave them unaware.
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
 * Where a shell renders routed views, unless it says otherwise. Both
 * applications in this repository mark the slot with `<main>`, which is also the
 * element a screen reader announces as the page's main content.
 */
const DEFAULT_OUTLET = 'main';

/**
 * @typedef {object} AttachOptions
 * @property {string} [outlet] Selector for the element inside the host that
 *   routed views render into. Defaults to `main`.
 */

/**
 * The attachment `navigate()` and `navigationSettled()` reach.
 *
 * One per document, because the listeners are: two routers would both claim the
 * same link click. Registered synchronously by `attachRouter`, so a component
 * that navigates before attaching finished waits for it rather than throwing.
 *
 * @type {RouterAttachment | null}
 */
let attached = null;

/**
 * A router attached to one shell. Obtained from `attachRouter`, which is also
 * what registers it as the one the module-level functions reach.
 *
 * The interface is the test surface: `navigate` and `settled` resolve when the
 * navigation has actually settled, so nothing waits on a timer.
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
   * Resolves once the entry URL is on screen, and rejects when attaching failed:
   * no outlet in the host, or a first navigation that could not resolve.
   *
   * @returns {Promise<void>}
   */
  get started() {
    return this.#started;
  }

  /**
   * The element the top level of the matched chain renders into. Null until
   * attaching has resolved it, which is also what a test asserts against rather
   * than repeating the lookup this module owns.
   *
   * @returns {HTMLElement | null}
   */
  get outlet() {
    return this.#outlet;
  }

  /**
   * Navigate, resolving when the navigation has settled. See `navigationError`
   * for whether it arrived.
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
   * Resolve when the attachment has nothing in flight: attaching itself, then any
   * navigation running under it.
   *
   * @returns {Promise<void>}
   */
  async settled() {
    const router = await this.#ready();
    await router?.settled();
  }

  /**
   * Release the attachment: stop listening, tear the mounted chain down, and stop
   * being the attachment the module-level functions reach.
   *
   * Safe before attaching has finished, which is what an application replacing
   * its router and a test tearing one down both need.
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
   * The router, once attaching has finished. Null when attaching failed or was
   * stopped before it finished: both mean there is nothing to navigate, and
   * neither is this caller's to report — `attachRouter` already rejected at
   * whoever asked for the attachment.
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
 * The host is the element whose own markup contains the outlet, so a shell hands
 * over `this` and nothing else; waiting for that render, finding the outlet,
 * checking its type, compiling the routes and listening are all in here. Rejects
 * when there is no outlet or the entry URL does not resolve, because startup is
 * the one navigation with an owner to report to.
 *
 * @param {HTMLElement} host
 * @param {readonly RouteDef[]} routes
 * @param {AttachOptions} [options]
 * @returns {Promise<RouterAttachment>}
 */
export async function attachRouter(host, routes, options) {
  // The outgoing attachment goes before anything of the new one exists. Two
  // routers listening to one document would both answer a link click, and the
  // loser would still be mounting views into an outlet nobody looks at.
  attached?.stop();

  const attachment = new RouterAttachment(host, routes, options?.outlet ?? DEFAULT_OUTLET);
  attached = attachment;

  try {
    await attachment.started;
  } catch (cause) {
    // `start` has already added the document listeners by the time the entry
    // navigation can fail, so a failed attach has to release them itself.
    attachment.stop();
    throw cause;
  }
  return attachment;
}

/**
 * Navigate. Resolves when the navigation has settled: the view is mounted, or a
 * guard's redirect has resolved instead. It does not reject — `navigationError`
 * holds the outcome — so a caller in an event handler can `void` it.
 *
 * Throws synchronously when no router is attached, which is a misuse rather than
 * a navigation failure.
 *
 * @param {string} href
 * @param {{ replace?: boolean }} [options]
 * @returns {Promise<void>}
 */
export function navigate(href, options) {
  return requireAttachment().navigate(href, options);
}

/**
 * Resolve when the attached router has nothing in flight.
 *
 * A link click, the back button and a shell that attached without awaiting are
 * navigations no caller holds a promise for; this is how anything waits for one
 * without a timer.
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
 * The wait is the point: `querySelector` in a shell's `onMount` runs before a
 * projecting layout component has put `<main>` back, and the failure is a router
 * that never starts — no error, an empty page with correct chrome.
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
 * Wrap a predicate as a guard. Angular's `canActivate`.
 *
 * @param {() => boolean | Promise<boolean>} allowed
 * @param {string} redirectTo
 * @returns {NonNullable<RouteDef['canActivate']>}
 */
export function guard(allowed, redirectTo) {
  return async () => ((await allowed()) ? true : redirectTo);
}
