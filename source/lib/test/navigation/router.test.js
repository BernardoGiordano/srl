import { html } from 'lit';
import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import {
  RouteOutlet,
  attachRouter,
  currentPath,
  navigate,
  navigationError,
  navigationSettled,
  queryParams,
  routeParams,
} from '@core/navigation/router.js';
import { assert, mount, present, settled, unmountAll } from '../harness.js';

/** @import { RouterAttachment } from '@core/navigation/router.js' */

/** @import { RouteDef } from '@core/navigation/types.js' */

class HomeView extends SignalElement {
  render() {
    return html`<span class="view">home</span>`;
  }
}
customElements.define('test-home-view', HomeView);

class UserView extends SignalElement {
  render() {
    return html`<span class="view">user:${routeParams.value.id ?? '?'}</span>`;
  }
}
customElements.define('test-user-view', UserView);

class GuardedView extends SignalElement {
  render() {
    return html`<span class="view">secret</span>`;
  }
}
customElements.define('test-guarded-view', GuardedView);

class LoginView extends SignalElement {
  render() {
    return html`<span class="view">login</span>`;
  }
}
customElements.define('test-login-view', LoginView);

class MountedView extends HTMLElement {}
customElements.define('test-mounted-view', MountedView);

/**
 * The element a matching test renders. It carries the name of the pattern that
 * matched, because what a matching assertion needs to read is which route
 * answered a URL, not what that route drew.
 */
class MarkerView extends HTMLElement {}
customElements.define('test-marker', MarkerView);

/**
 * A route that marks itself when it matches.
 *
 * `mount` rather than `component` so one element definition serves every pattern:
 * custom element names are permanent, and a test table needs a dozen distinct
 * answers.
 *
 * @param {string} path
 * @param {string} mark
 * @returns {RouteDef}
 */
function marks(path, mark) {
  return {
    path,
    mount: () => {
      const element = document.createElement('test-marker');
      element.dataset.mark = mark;
      return element;
    },
  };
}

/**
 * A shell whose outlet does not exist yet when its `onMount` runs, because Lit
 * only schedules the render that creates it. The real shells are worse — one of
 * them keeps its `<main>` inside a component that projects content, so the
 * element arrives a further turn later — and both are why waiting for it is the
 * attachment's job rather than every shell's.
 */
class ShellHost extends SignalElement {
  render() {
    return html`<header>chrome</header>
      <main></main>`;
  }
}
customElements.define('test-shell-host', ShellHost);

/** How many times each layout has been constructed, per test. */
const built = { shell: 0, section: 0 };

/** A layout route's component: its own chrome plus the slot its children fill. */
class ShellLayout extends SignalElement {
  constructor() {
    super();
    built.shell += 1;
  }

  render() {
    return html`<span class="layout">shell</span><x-route-outlet></x-route-outlet>`;
  }
}
customElements.define('test-shell-layout', ShellLayout);

/** A second level of nesting, to prove the chain is not two levels deep by luck. */
class SectionLayout extends SignalElement {
  constructor() {
    super();
    built.section += 1;
  }

  render() {
    return html`<span class="section">section</span><x-route-outlet></x-route-outlet>`;
  }
}
customElements.define('test-section-layout', SectionLayout);

/** A layout whose author forgot the outlet. */
class OutletlessLayout extends SignalElement {
  render() {
    return html`<span class="layout">no outlet here</span>`;
  }
}
customElements.define('test-outletless-layout', OutletlessLayout);

class ChildAView extends SignalElement {
  render() {
    return html`<span class="view">child-a</span>`;
  }
}
customElements.define('test-child-a-view', ChildAView);

class ChildBView extends SignalElement {
  render() {
    return html`<span class="view">child-b</span>`;
  }
}
customElements.define('test-child-b-view', ChildBView);

class TeamView extends SignalElement {
  render() {
    const { org, team } = routeParams.value;
    return html`<span class="view">${org ?? '?'}/${team ?? '?'}</span>`;
  }
}
customElements.define('test-team-view', TeamView);

/**
 * A layout whose markup comes from an `.html` file, like every real one: the
 * outlet then arrives through the template compiler and a fetch, which is the
 * path an application actually takes, rather than from a lit template written
 * inline in this file.
 */
// Exported because cli/checks/template-check.mjs discovers this pair like any other
// and type-checks the fixture template against the class, which is worth having.
export class TemplatedLayout extends SignalElement {}

// `template` names the fixture because it is not this module's sibling, and
// `uses` lists the outlet like any layout template's dependency.
await defineComponent({
  tag: 'test-templated-layout',
  element: TemplatedLayout,
  module: import.meta.url,
  template: '../fixtures/route-layout.html',
  uses: [RouteOutlet],
});

/** Resolves only when released, for deterministic navigation races. */
function deferred() {
  /** @type {() => void} */
  let release = () => undefined;
  const promise = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  return { promise, release: () => release() };
}

describe('router attachment', () => {
  /** @type {RouterAttachment | null} */
  let app = null;
  /** @type {string} */
  let restoreUrl = '';

  /**
   * Attach a router at `at`, through the same interface an application crosses.
   *
   * The host is a plain `<div>` holding the outlet, which is what a shell's own
   * template amounts to. `attachRouter` finds the outlet itself, so nothing here
   * repeats the lookup, and it resolves the entry URL before returning, so no test
   * below waits for one.
   *
   * @param {readonly RouteDef[]} routes
   * @param {string} at
   * @returns {Promise<HTMLElement>}
   */
  async function startAt(routes, at) {
    const host = mount('<div><main></main></div>');
    history.replaceState(null, '', at);
    app = await attachRouter(host, routes);
    return present(app.outlet);
  }

  beforeEach(() => {
    restoreUrl = location.pathname + location.search;
    navigationError.value = null;
  });

  afterEach(() => {
    app?.stop();
    app = null;
    history.replaceState(null, '', restoreUrl);
    unmountAll();
  });

  it('waits for the host to render before looking for its outlet', async () => {
    const host = mount('<test-shell-host></test-shell-host>');
    history.replaceState(null, '', '/');
    assert.equal(host.querySelector('main'), null, 'the outlet cannot exist yet');

    app = await attachRouter(host, [{ path: '/', component: 'test-home-view' }]);

    const outlet = present(app.outlet);
    assert.equal(outlet.localName, 'main');
    assert.equal(present(outlet.firstElementChild).localName, 'test-home-view');
  });

  it('reports a host that renders no outlet', async () => {
    const host = mount('<div><section></section></div>');
    history.replaceState(null, '', '/');

    await assert.rejects(
      () => attachRouter(host, [{ path: '/', component: 'test-home-view' }]),
      'renders no element matching "main"',
    );
  });

  it('renders into the outlet a host names', async () => {
    const host = mount('<div><div id="views"></div></div>');
    history.replaceState(null, '', '/');

    app = await attachRouter(host, [{ path: '/', component: 'test-home-view' }], {
      outlet: '#views',
    });

    assert.equal(present(app.outlet).id, 'views');
  });

  it('publishes a failed navigation rather than rejecting at nobody', async () => {
    const outlet = await startAt(
      [
        { path: '/', component: 'test-home-view' },
        // A `load` that resolves without defining the element it names, which is
        // the mistake @core/elements/mount.js reports naming the tag.
        { path: '/broken', component: 'test-never-defined-view', load: () => Promise.resolve() },
      ],
      '/',
    );

    // Resolves rather than rejects: the same navigation could have come from a
    // link click, and a failure channel that only exists for callers is how a
    // broken route becomes a blank page nobody hears about.
    await navigate('/broken');

    assert.includes(present(navigationError.value).message, 'test-never-defined-view');
    assert.equal(
      outlet.firstElementChild?.localName,
      'test-home-view',
      'a failed navigation leaves the view that is on screen',
    );

    await navigate('/');
    assert.equal(navigationError.value, null, 'a navigation that arrives clears it');
  });

  it('settles a navigation no caller started', async () => {
    const outlet = await startAt(
      [
        { path: '/', component: 'test-home-view' },
        { path: '/users/:id', component: 'test-user-view' },
      ],
      '/',
    );

    // What the back button does. Nobody holds a promise for it, and this is how a
    // test waits for one anyway instead of sleeping until the view shows up.
    history.pushState(null, '', '/users/5');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await navigationSettled();

    assert.equal(outlet.firstElementChild?.localName, 'test-user-view');
    assert.equal(routeParams.value.id, '5');
  });

  it('releases the chain and detaches on stop', async () => {
    const outlet = await startAt([{ path: '/', component: 'test-home-view' }], '/');
    const attachment = present(app);

    attachment.stop();
    // Teardown is in flight like a navigation, so one settle covers it: the
    // `unmount` hooks of the chain are awaited before this returns.
    await attachment.settled();

    assert.equal(outlet.childElementCount, 0, 'the mounted chain is released');
    assert.throws(() => navigate('/'), 'No router is attached');
  });

  it('mounts the matching component and publishes the path', async () => {
    const outlet = await startAt([{ path: '/', component: 'test-home-view' }], '/');
    await settled(present(outlet.firstElementChild));

    assert.equal(outlet.querySelector('.view')?.textContent, 'home');
    assert.equal(currentPath.value, '/');
  });

  it('publishes params before the component first renders', async () => {
    const outlet = await startAt(
      [{ path: '/users/:id', component: 'test-user-view' }],
      '/users/7',
    );
    await settled(present(outlet.firstElementChild));

    // If params were published after mounting, this would read "user:?" on the
    // first paint and only correct itself on a later render.
    assert.equal(outlet.querySelector('.view')?.textContent, 'user:7');
  });

  it('reuses the instance when only a parameter changes', async () => {
    const outlet = await startAt(
      [{ path: '/users/:id', component: 'test-user-view' }],
      '/users/1',
    );
    const first = present(outlet.firstElementChild);
    await settled(first);

    await navigate('/users/2');
    await settled(first);

    assert.equal(outlet.firstElementChild, first, 'must re-render, not remount');
    assert.equal(outlet.querySelector('.view')?.textContent, 'user:2');
  });

  it('percent-decodes parameters', async () => {
    const outlet = await startAt(
      [{ path: '/users/:id', component: 'test-user-view' }],
      '/users/a%20b',
    );
    await settled(present(outlet.firstElementChild));
    assert.equal(routeParams.value.id, 'a b');
  });

  it('redirects when a guard returns a path', async () => {
    const outlet = await startAt(
      [
        { path: '/secret', component: 'test-guarded-view', canActivate: () => '/login' },
        { path: '/login', component: 'test-login-view' },
      ],
      '/secret',
    );
    await settled(present(outlet.firstElementChild));

    assert.equal(outlet.querySelector('.view')?.textContent, 'login');
    assert.equal(location.pathname, '/login', 'the URL must follow the redirect');
  });

  it('allows navigation when a guard returns true', async () => {
    const outlet = await startAt(
      [
        { path: '/secret', component: 'test-guarded-view', canActivate: () => true },
        { path: '/login', component: 'test-login-view' },
      ],
      '/secret',
    );
    await settled(present(outlet.firstElementChild));
    assert.equal(outlet.querySelector('.view')?.textContent, 'secret');
  });

  it('follows a static redirect', async () => {
    const outlet = await startAt(
      [
        { path: '/old', redirect: '/' },
        { path: '/', component: 'test-home-view' },
      ],
      '/old',
    );
    await settled(present(outlet.firstElementChild));
    assert.equal(outlet.querySelector('.view')?.textContent, 'home');
  });

  it('reports a redirect loop rather than hanging', async () => {
    const host = mount('<div><main></main></div>');
    history.replaceState(null, '', '/loop-a');

    // The entry navigation is part of attaching, so its failure is the one that
    // reaches the caller instead of only `navigationError`.
    await assert.rejects(
      () =>
        attachRouter(host, [
          { path: '/loop-a', redirect: '/loop-b' },
          { path: '/loop-b', redirect: '/loop-a' },
        ]),
      'Redirect loop',
    );
  });

  it('lazily loads a component on first match only', async () => {
    let loads = 0;
    const routes = [
      { path: '/', component: 'test-home-view' },
      {
        path: '/lazy',
        component: 'test-lazy-view',
        load: () => {
          loads += 1;
          customElements.define(
            'test-lazy-view',
            class extends SignalElement {
              render() {
                return html`<span class="view">lazy</span>`;
              }
            },
          );
          return Promise.resolve();
        },
      },
    ];

    const outlet = await startAt(routes, '/');
    assert.equal(loads, 0, 'must not load a route that was never visited');

    await navigate('/lazy');
    await settled(present(outlet.firstElementChild));
    assert.equal(outlet.querySelector('.view')?.textContent, 'lazy');
    assert.equal(loads, 1);

    await navigate('/');
    await navigate('/lazy');
    assert.equal(loads, 1, 'an already-defined element must not be loaded again');
  });

  it('mounts a route that names its component as a class', async () => {
    // What an application's route table looks like now: an eager route holds the
    // class it imported, a lazy one resolves the class from its `load`, and
    // neither writes a tag down for the two of them to disagree about.
    class EagerView extends SignalElement {
      render() {
        return html`<span class="view">eager</span>`;
      }
    }
    await defineComponent({
      tag: 'test-eager-view',
      element: EagerView,
      module: import.meta.url,
      template: false,
    });

    const outlet = await startAt(
      [
        { path: '/', component: EagerView },
        {
          path: '/resolved',
          load: () => {
            class ResolvedView extends SignalElement {
              render() {
                return html`<span class="view">resolved</span>`;
              }
            }
            return defineComponent({
              tag: 'test-resolved-view',
              element: ResolvedView,
              module: import.meta.url,
              template: false,
            }).then(() => ResolvedView);
          },
        },
      ],
      '/',
    );

    assert.equal(outlet.querySelector('.view')?.textContent, 'eager');

    await navigate('/resolved');
    await settled(present(outlet.firstElementChild));
    assert.equal(outlet.querySelector('.view')?.textContent, 'resolved');
  });

  it('pairs every route-owned mount with exactly one unmount', async () => {
    let mounts = 0;
    /** @type {HTMLElement[]} */
    const released = [];
    const managed = {
      path: '/managed',
      mount: () => {
        mounts += 1;
        return document.createElement('test-mounted-view');
      },
      unmount: (/** @type {HTMLElement} */ element) => {
        released.push(element);
      },
    };
    const outlet = await startAt(
      [managed, { path: '/', component: 'test-home-view' }],
      '/managed',
    );
    const first = present(outlet.firstElementChild);

    await navigate('/');
    assert.equal(released.length, 1);
    assert.equal(released[0], first);

    await navigate('/managed');
    const second = present(outlet.firstElementChild);
    assert.equal(mounts, 2, 'returning to a route must create a fresh mount');
    assert.notOk(second === first);

    await navigate('/managed/');
    assert.equal(mounts, 2, 'the same active route must retain its instance');
  });

  it('unmounts a stale route-owned element that loses a navigation race', async () => {
    const slow = deferred();
    /** @type {HTMLElement[]} */
    const released = [];
    const outlet = await startAt(
      [
        { path: '/', component: 'test-home-view' },
        {
          path: '/slow-managed',
          mount: async () => {
            await slow.promise;
            return document.createElement('test-mounted-view');
          },
          unmount: (/** @type {HTMLElement} */ element) => {
            released.push(element);
          },
        },
      ],
      '/',
    );

    const stale = navigate('/slow-managed');
    await Promise.resolve();
    await navigate('/');
    slow.release();
    await stale;

    assert.equal(outlet.firstElementChild?.localName, 'test-home-view');
    assert.equal(released.length, 1, 'a never-inserted stale mount still needs teardown');
  });

  /**
   * A navigation that does not arrive must leave nothing of itself behind.
   *
   * The view that stays on screen was already covered; what these assert is the
   * rest of the same fact — the URL, `currentPath`, `routeParams` and
   * `queryParams` all still describe the screen the user is looking at. A router
   * that publishes a destination it could not render makes every reader of those
   * signals wrong at once: an active link, a breadcrumb, a page title, and any
   * code that reloads data from `routeParams`.
   */
  describe('a failed navigation', () => {
    /** A route whose `load` resolves without defining the element it names. */
    const unbuildable = {
      path: '/broken',
      component: 'test-never-defined-view',
      load: () => Promise.resolve(),
    };

    it('leaves the URL and the route state on the view that is still mounted', async () => {
      const outlet = await startAt(
        [{ path: '/users/:id', component: 'test-user-view' }, unbuildable],
        '/users/7?tab=roles',
      );

      await navigate('/broken');

      assert.includes(present(navigationError.value).message, 'test-never-defined-view');
      assert.equal(outlet.firstElementChild?.localName, 'test-user-view');
      assert.equal(currentPath.value, '/users/7', 'the published path is the one on screen');
      assert.equal(routeParams.value.id, '7');
      assert.equal(queryParams.value.get('tab'), 'roles');
      assert.equal(
        location.pathname + location.search,
        '/users/7?tab=roles',
        'the URL goes back whole, query string included',
      );
    });

    it('stays where it is when a lazy module rejects', async () => {
      const outlet = await startAt(
        [
          { path: '/', component: 'test-home-view' },
          {
            path: '/offline',
            component: 'test-offline-view',
            load: () => Promise.reject(new Error('network down')),
          },
        ],
        '/',
      );

      await navigate('/offline');

      assert.includes(present(navigationError.value).message, 'network down');
      assert.equal(outlet.firstElementChild?.localName, 'test-home-view');
      assert.equal(currentPath.value, '/');
      assert.equal(location.pathname, '/');
    });

    it('mounts no part of a chain whose deeper level cannot be built', async () => {
      const outlet = await startAt(
        [
          { path: '/', component: 'test-home-view' },
          {
            path: '/settings',
            component: 'test-shell-layout',
            children: [
              {
                path: 'users',
                component: 'test-missing-child-view',
                load: () => Promise.resolve(),
              },
            ],
          },
        ],
        '/',
      );

      await navigate('/settings/users');

      assert.includes(present(navigationError.value).message, 'test-missing-child-view');
      assert.equal(
        document.querySelector('test-shell-layout'),
        null,
        'a layout is not put on screen for a child that will never arrive',
      );
      assert.equal(outlet.firstElementChild?.localName, 'test-home-view');
      assert.equal(currentPath.value, '/');
      assert.equal(location.pathname, '/');
    });

    it('keeps a mounted chain intact when only its new leaf fails', async () => {
      const outlet = await startAt(
        [
          {
            path: '/a',
            component: 'test-shell-layout',
            children: [
              { path: 'one', component: 'test-child-a-view' },
              {
                path: 'broken',
                component: 'test-missing-leaf-view',
                load: () => Promise.resolve(),
              },
            ],
          },
        ],
        '/a/one',
      );
      const layout = present(outlet.firstElementChild);
      await settled(layout);

      await navigate('/a/broken');

      assert.includes(present(navigationError.value).message, 'test-missing-leaf-view');
      assert.equal(outlet.firstElementChild, layout, 'the surviving layout is not remounted');
      assert.equal(
        present(layout.querySelector('x-route-outlet')).firstElementChild?.localName,
        'test-child-a-view',
        'the child that is on screen stays there',
      );
      assert.equal(currentPath.value, '/a/one');
      assert.equal(location.pathname, '/a/one');
    });

    it('releases a level it built for a chain it could not place', async () => {
      let released = 0;
      const outlet = await startAt(
        [
          { path: '/', component: 'test-home-view' },
          {
            path: '/managed',
            mount: () => document.createElement('test-mounted-view'),
            unmount: () => {
              released += 1;
            },
            children: [
              {
                path: 'inner',
                component: 'test-missing-inner-view',
                load: () => Promise.resolve(),
              },
            ],
          },
        ],
        '/',
      );

      await navigate('/managed/inner');

      assert.equal(released, 1, 'a level built for a failed chain still gets its unmount');
      assert.equal(outlet.firstElementChild?.localName, 'test-home-view');
      assert.equal(currentPath.value, '/');
    });

    it('leaves no history entry for a URL that never arrived', async () => {
      const outlet = await startAt(
        [
          { path: '/', component: 'test-home-view' },
          { path: '/users/:id', component: 'test-user-view' },
          unbuildable,
        ],
        '/',
      );

      await navigate('/users/1');
      await navigate('/broken');
      assert.equal(location.pathname, '/users/1');

      // The entry `navigate` pushed for `/broken` is still there — putting the URL
      // back is a `replaceState`, because `history.go(1)` races the popstate it
      // triggers — but it holds the URL that is on screen, so going back cannot
      // land on a route that failed.
      const popped = new Promise((resolve) => {
        window.addEventListener('popstate', () => resolve(undefined), { once: true });
      });
      history.back();
      await popped;
      await navigationSettled();

      assert.equal(location.pathname, '/users/1');
      assert.equal(currentPath.value, '/users/1');
      assert.equal(outlet.firstElementChild?.localName, 'test-user-view');
    });

    /*
     * Past the point of no return.
     *
     * Everything a level needs is built before the outgoing chain is released, so
     * these are the two failures left that can only happen afterwards: a layout
     * that renders no outlet, which cannot be discovered until that layout is on
     * screen, and an `unmount` hook that throws while the previous view is being
     * released. Neither can be undone — the screen the URL would go back to no
     * longer exists — so the state describes the destination and
     * `navigationError` says it did not finish arriving.
     */
    it('reports a layout with no outlet against the destination it could not finish', async () => {
      const outlet = await startAt(
        [
          { path: '/', component: 'test-home-view' },
          {
            path: '/no-outlet',
            component: 'test-outletless-layout',
            children: [{ path: 'inner', component: 'test-child-a-view' }],
          },
        ],
        '/',
      );

      await navigate('/no-outlet/inner');

      assert.includes(present(navigationError.value).message, 'contains no <x-route-outlet>');
      assert.equal(currentPath.value, '/no-outlet/inner');
      assert.equal(location.pathname, '/no-outlet/inner');
      assert.equal(
        outlet.firstElementChild?.localName,
        'test-outletless-layout',
        'the level that did mount is the one the state describes',
      );
    });

    it('reports an unmount that threw, and releases what it had already built', async () => {
      let released = 0;
      const outlet = await startAt(
        [
          {
            path: '/leaving',
            component: 'test-home-view',
            unmount: () => {
              throw new Error('teardown exploded');
            },
          },
          {
            path: '/next',
            mount: () => document.createElement('test-mounted-view'),
            unmount: () => {
              released += 1;
            },
          },
        ],
        '/leaving',
      );

      await navigate('/next');

      assert.includes(present(navigationError.value).message, 'teardown exploded');
      assert.equal(released, 1, 'the element built for /next never reaches the DOM, so it is released');
      assert.equal(outlet.childElementCount, 0);
      assert.equal(currentPath.value, '/next');
    });
  });

  describe('canDeactivate', () => {
    it('refuses a navigation and puts the URL back', async () => {
      const outlet = await startAt(
        [
          { path: '/', component: 'test-home-view' },
          { path: '/edit', component: 'test-user-view', canDeactivate: () => false },
        ],
        '/edit',
      );

      await navigate('/');

      assert.equal(location.pathname, '/edit', 'the URL must agree with what is on screen');
      assert.equal(outlet.firstElementChild?.localName, 'test-user-view', 'and the screen must still be there');
    });

    it('lets the navigation through when the guard allows it', async () => {
      /** @type {string[]} */
      const asked = [];
      const outlet = await startAt(
        [
          { path: '/', component: 'test-home-view' },
          {
            path: '/edit',
            component: 'test-user-view',
            canDeactivate: ({ element, to }) => {
              asked.push(`${present(element).localName} to ${to?.pathname ?? 'nothing'}`);
              return true;
            },
          },
        ],
        '/edit',
      );

      await navigate('/');

      assert.sameArray(asked, ['test-user-view to /'], 'the guard is told what it is being left for');
      assert.equal(outlet.firstElementChild?.localName, 'test-home-view');
    });

    it('waits for a guard that answers late', async () => {
      const answer = deferred();
      const outlet = await startAt(
        [
          { path: '/', component: 'test-home-view' },
          { path: '/edit', component: 'test-user-view', canDeactivate: () => answer.promise.then(() => true) },
        ],
        '/edit',
      );

      const leaving = navigate('/');
      await Promise.resolve();
      assert.equal(outlet.firstElementChild?.localName, 'test-user-view', 'nothing moves while the answer is pending');

      answer.release();
      await leaving;
      assert.equal(outlet.firstElementChild?.localName, 'test-home-view');
    });

    it('does not ask a level that is not being released', async () => {
      let asked = 0;
      await startAt(
        [
          {
            path: '/users',
            component: 'test-shell-layout',
            canDeactivate: () => {
              asked += 1;
              return true;
            },
            children: [
              { path: ':id', component: 'test-user-view' },
              { path: ':id/edit', component: 'test-home-view' },
            ],
          },
        ],
        '/users/1',
      );

      // A parameter change re-renders in place, and the layout above it survives
      // its children changing. Neither is a deactivation, and a guard asked on
      // either would prompt the user for navigations they never left a screen for.
      await navigate('/users/2');
      await navigate('/users/2/edit');
      assert.equal(asked, 0);
    });

    it('asks the deepest level first', async () => {
      /** @type {string[]} */
      const order = [];
      await startAt(
        [
          { path: '/', component: 'test-home-view' },
          {
            path: '/section',
            component: 'test-shell-layout',
            canDeactivate: () => {
              order.push('parent');
              return true;
            },
            children: [
              {
                path: 'child',
                component: 'test-user-view',
                canDeactivate: () => {
                  order.push('child');
                  return true;
                },
              },
            ],
          },
        ],
        '/section/child',
      );

      await navigate('/');

      assert.sameArray(order, ['child', 'parent'], 'the specific question reaches the user before the general one');
    });

    it('is not asked when the router is detached', async () => {
      let asked = 0;
      await startAt(
        [
          {
            path: '/edit',
            component: 'test-user-view',
            canDeactivate: () => {
              asked += 1;
              return false;
            },
          },
        ],
        '/edit',
      );

      // `stop()` is a teardown, not a navigation: there is nowhere to stay, and a
      // guard that refused would leak the element it was protecting.
      app?.stop();
      await app?.settled();
      app = null;
      assert.equal(asked, 0);
    });
  });

  it('falls through to a catch-all route', async () => {
    const outlet = await startAt(
      [
        { path: '/', component: 'test-home-view' },
        { path: '*', component: 'test-login-view' },
      ],
      '/nothing/here',
    );
    await settled(present(outlet.firstElementChild));
    assert.equal(outlet.querySelector('.view')?.textContent, 'login');
  });

  it('intercepts same-origin link clicks', async () => {
    const outlet = await startAt(
      [
        { path: '/', component: 'test-home-view' },
        { path: '/users/:id', component: 'test-user-view' },
      ],
      '/',
    );

    const link = document.createElement('a');
    link.href = '/users/9';
    document.body.append(link);

    // Insurance, not part of what is asserted: the router is expected to claim this
    // click, and if it ever stopped doing so the browser would load /users/9 for
    // real and this file would lose its results instead of reporting one failure.
    /** @param {Event} event */
    const blockDefault = (event) => event.preventDefault();
    window.addEventListener('click', blockDefault);

    try {
      link.click();
      // Let the click handler's navigate() settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await settled(present(outlet.firstElementChild));

      assert.equal(location.pathname, '/users/9');
      assert.equal(outlet.querySelector('.view')?.textContent, 'user:9');
    } finally {
      window.removeEventListener('click', blockDefault);
      link.remove();
    }
  });

  it('leaves links alone that opt out', async () => {
    await startAt([{ path: '/', component: 'test-home-view' }], '/');

    /**
     * What the browser would do with a link the router declines is exactly the
     * problem: a real page load, a popup or a download, any of which takes the
     * test page with it and loses every result this file has produced. The
     * router's listener is on `document`, so this one goes on `window`: it reads
     * the verdict after the router has had its say, then stops the browser from
     * acting on it.
     *
     * @type {boolean[]}
     */
    const claimed = [];
    /** @param {Event} event */
    const blockDefault = (event) => {
      claimed.push(event.defaultPrevented);
      event.preventDefault();
    };
    window.addEventListener('click', blockDefault);

    try {
      for (const configure of [
        /** @param {HTMLAnchorElement} a */ (a) => a.setAttribute('download', ''),
        /** @param {HTMLAnchorElement} a */ (a) => (a.target = '_blank'),
        /** @param {HTMLAnchorElement} a */ (a) => (a.rel = 'external'),
        /** @param {HTMLAnchorElement} a */ (a) => (a.dataset.routerIgnore = ''),
      ]) {
        const link = document.createElement('a');
        link.href = '/users/1';
        configure(link);
        document.body.append(link);

        link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
        link.remove();

        assert.notOk(claimed.at(-1), `router must not claim this link: ${link.outerHTML}`);
      }
    } finally {
      window.removeEventListener('click', blockDefault);
    }
  });

  /**
   * Path patterns, asserted the way an application meets them.
   *
   * Matching used to be tested by compiling a pattern and probing the regular
   * expression it produced, which pinned an implementation rather than a
   * behaviour: every case below would have had to be rewritten to move matching
   * behind an index, and none of them would have caught the move being wrong. A
   * navigation answers the same questions — which route matched, with which
   * parameters — through the interface a shell crosses.
   */
  describe('path matching', () => {
    /**
     * Navigate to `at` and report which route answered: its mark, or the tag of
     * whatever is mounted, or `'none'` when nothing is.
     *
     * The marker is looked for anywhere under the outlet, so a nested leaf reports
     * itself rather than the layout it renders inside.
     *
     * @param {HTMLElement} outlet
     * @param {string} at
     * @returns {Promise<string>}
     */
    async function matchAt(outlet, at) {
      await navigate(at);
      const marker = outlet.querySelector('test-marker');
      if (marker instanceof HTMLElement) return marker.dataset.mark ?? 'unmarked';
      return outlet.firstElementChild?.localName ?? 'none';
    }

    it('matches a literal path, tolerating a trailing slash', async () => {
      const outlet = await startAt([marks('/users', 'users'), marks('*', 'catch')], '/users');

      assert.equal(await matchAt(outlet, '/users'), 'users');
      assert.equal(await matchAt(outlet, '/users/'), 'users', 'a trailing slash is the same URL');
      assert.equal(await matchAt(outlet, '/users/1'), 'catch', 'but a further segment is not');
      assert.equal(await matchAt(outlet, '/user'), 'catch', 'nor is a prefix of the literal');
    });

    it('captures a named parameter from a single segment', async () => {
      const outlet = await startAt(
        [marks('/users/:id/edit', 'edit'), marks('*', 'catch')],
        '/users/42/edit',
      );

      assert.equal(await matchAt(outlet, '/users/42/edit'), 'edit');
      assert.equal(routeParams.value.id, '42');
      assert.equal(
        await matchAt(outlet, '/users/42/99/edit'),
        'catch',
        'a parameter must not span a slash',
      );
    });

    it('matches its own root with a trailing wildcard, and captures the rest', async () => {
      const outlet = await startAt(
        [marks('/billing/*', 'billing'), marks('*', 'catch')],
        '/billing',
      );

      assert.equal(await matchAt(outlet, '/billing'), 'billing', 'the mount path itself matches');
      assert.equal(routeParams.value.rest, undefined, 'with nothing after the prefix');

      assert.equal(await matchAt(outlet, '/billing/invoices'), 'billing');
      assert.equal(routeParams.value.rest, 'invoices');

      assert.equal(await matchAt(outlet, '/billing/invoices/2026'), 'billing');
      assert.equal(routeParams.value.rest, 'invoices/2026', 'the remainder is one parameter');

      assert.equal(await matchAt(outlet, '/billingx'), 'catch', 'the prefix ends at a segment');
    });

    it('treats a regex metacharacter in a literal as literal', async () => {
      const outlet = await startAt([marks('/a.b', 'literal'), marks('*', 'catch')], '/a.b');

      assert.equal(await matchAt(outlet, '/a.b'), 'literal');
      assert.equal(await matchAt(outlet, '/axb'), 'catch', 'the dot must not act as a wildcard');
    });

    it('matches the root path and nothing below it', async () => {
      const outlet = await startAt([marks('/', 'root'), marks('*', 'catch')], '/');

      assert.equal(await matchAt(outlet, '/'), 'root');
      assert.equal(await matchAt(outlet, '/other'), 'catch');
    });

    it('takes the first route that matches, not the most specific', async () => {
      const declared = await startAt(
        [marks('/users/:id', 'param'), marks('/users/new', 'literal')],
        '/users/new',
      );
      assert.equal(await matchAt(declared, '/users/new'), 'param');

      // The same two routes, the same URL, the other order. Declaration order is
      // the whole rule: a literal that must win goes above the parameter.
      const reversed = await startAt(
        [marks('/users/new', 'literal'), marks('/users/:id', 'param')],
        '/users/new',
      );
      assert.equal(await matchAt(reversed, '/users/new'), 'literal');
    });

    it('empties the outlet when nothing matches and no catch-all is declared', async () => {
      const outlet = await startAt([marks('/users', 'users')], '/users');

      assert.equal(await matchAt(outlet, '/nothing/here'), 'none');
      assert.equal(currentPath.value, '/nothing/here', 'the URL is still published');
      assert.equal(navigationError.value, null, 'no match is not a navigation failure');
      assert.equal(await matchAt(outlet, '/users'), 'users', 'and the table still matches after');
    });

    it('joins a child path onto its parent, and never matches a parent alone', async () => {
      const outlet = await startAt(
        [
          {
            path: '/settings',
            component: 'test-shell-layout',
            children: [marks('users/:id', 'user')],
          },
          marks('*', 'catch'),
        ],
        '/settings/users/7',
      );

      assert.equal(await matchAt(outlet, '/settings/users/7'), 'user');
      assert.equal(routeParams.value.id, '7');
      assert.equal(
        await matchAt(outlet, '/settings'),
        'catch',
        'a parent with no index child is not a URL of its own',
      );
    });

    it('reports a child tree no URL could reach, at attachment', async () => {
      const host = mount('<div><main></main></div>');
      history.replaceState(null, '', '/x/y');

      // Route installation is part of attaching, so a tree that could never match
      // is reported to whoever attached it rather than at the first navigation
      // that quietly finds nothing.
      await assert.rejects(
        () =>
          attachRouter(host, [
            { path: '/x/*', children: [{ path: 'y', component: 'test-child-a-view' }] },
          ]),
        'behind a wildcard',
      );

      await assert.rejects(
        () =>
          attachRouter(host, [
            {
              path: '/x',
              redirect: '/y',
              children: [{ path: 'z', component: 'test-child-a-view' }],
            },
          ]),
        'children` and `redirect',
      );
    });
  });

  describe('child layout routes', () => {
    beforeEach(() => {
      built.shell = 0;
      built.section = 0;
    });

    /**
     * Settle every level of the mounted chain, outermost first. A level's child
     * only exists once that level has rendered its outlet, so the walk has to go
     * down as it goes along.
     *
     * @param {Element} root
     * @returns {Promise<void>}
     */
    async function settleChain(root) {
      /** @type {Element | null} */
      let node = root;
      while (node !== null) {
        await settled(node);
        node = node.querySelector('x-route-outlet')?.firstElementChild ?? null;
      }
    }

    it('renders a child in the layout outlet and keeps the layout across siblings', async () => {
      const outlet = await startAt(
        [
          {
            path: '/settings',
            component: 'test-shell-layout',
            children: [
              { path: 'users', component: 'test-child-a-view' },
              { path: 'roles', component: 'test-child-b-view' },
            ],
          },
        ],
        '/settings/users',
      );

      const layout = present(outlet.firstElementChild);
      await settleChain(layout);
      const slot = present(layout.querySelector('x-route-outlet'));

      assert.equal(layout.localName, 'test-shell-layout');
      assert.equal(outlet.querySelector('.view')?.textContent, 'child-a');
      assert.equal(slot.firstElementChild?.localName, 'test-child-a-view');

      await navigate('/settings/roles');
      await settleChain(layout);

      assert.equal(outlet.firstElementChild, layout, 'the layout must not remount');
      assert.equal(built.shell, 1);
      assert.equal(slot.childElementCount, 1, 'the outgoing child must be gone');
      assert.equal(outlet.querySelector('.view')?.textContent, 'child-b');
    });

    it('matches a child with an empty path at the parent URL', async () => {
      const outlet = await startAt(
        [
          {
            path: '/settings',
            component: 'test-shell-layout',
            children: [
              { path: '', component: 'test-child-a-view' },
              { path: 'roles', component: 'test-child-b-view' },
            ],
          },
          { path: '*', component: 'test-login-view' },
        ],
        '/settings',
      );
      await settleChain(present(outlet.firstElementChild));

      assert.equal(outlet.querySelector('.layout')?.textContent, 'shell');
      assert.equal(outlet.querySelector('.view')?.textContent, 'child-a');
    });

    it('follows a redirect on an index child without mounting the layout twice', async () => {
      const outlet = await startAt(
        [
          {
            path: '/settings',
            component: 'test-shell-layout',
            children: [
              { path: '', redirect: '/settings/roles' },
              { path: 'roles', component: 'test-child-b-view' },
            ],
          },
        ],
        '/settings',
      );
      await settleChain(present(outlet.firstElementChild));

      assert.equal(location.pathname, '/settings/roles');
      assert.equal(outlet.querySelector('.view')?.textContent, 'child-b');
      assert.equal(built.shell, 1, 'the redirect resolves before anything is mounted');
    });

    it('merges parameters from every level of the chain', async () => {
      const outlet = await startAt(
        [
          {
            path: '/orgs/:org',
            component: 'test-shell-layout',
            children: [{ path: 'teams/:team', component: 'test-team-view' }],
          },
        ],
        '/orgs/acme/teams/core',
      );
      await settleChain(present(outlet.firstElementChild));

      assert.equal(routeParams.value.org, 'acme');
      assert.equal(routeParams.value.team, 'core');
      assert.equal(outlet.querySelector('.view')?.textContent, 'acme/core');
    });

    it('keeps every ancestor mounted when only the leaf changes', async () => {
      const outlet = await startAt(
        [
          {
            path: '/a',
            component: 'test-shell-layout',
            children: [
              {
                path: 'b',
                component: 'test-section-layout',
                children: [
                  { path: 'one', component: 'test-child-a-view' },
                  { path: 'two', component: 'test-child-b-view' },
                ],
              },
            ],
          },
        ],
        '/a/b/one',
      );
      const shell = present(outlet.firstElementChild);
      await settleChain(shell);
      const section = present(shell.querySelector('test-section-layout'));

      await navigate('/a/b/two');
      await settleChain(shell);

      assert.equal(outlet.firstElementChild, shell);
      assert.equal(shell.querySelector('test-section-layout'), section);
      assert.equal(built.shell, 1);
      assert.equal(built.section, 1);
      assert.equal(outlet.querySelector('.view')?.textContent, 'child-b');
    });

    it('tears the chain down deepest first, and rebuilds it on return', async () => {
      /** @type {string[]} */
      const released = [];
      const outlet = await startAt(
        [
          {
            path: '/settings',
            component: 'test-shell-layout',
            unmount: () => {
              released.push('layout');
            },
            children: [
              {
                path: 'users',
                component: 'test-child-a-view',
                unmount: () => {
                  released.push('child');
                },
              },
            ],
          },
          { path: '/', component: 'test-home-view' },
        ],
        '/settings/users',
      );
      await settleChain(present(outlet.firstElementChild));

      await navigate('/');
      assert.sameArray(released, ['child', 'layout'], 'a child outlives nothing it renders in');
      assert.equal(outlet.firstElementChild?.localName, 'test-home-view');

      await navigate('/settings/users');
      await settleChain(present(outlet.firstElementChild));
      assert.equal(built.shell, 2, 'coming back is a fresh layout, as it is for a leaf');
    });

    it('runs a parent guard before a child loads its module', async () => {
      let loads = 0;
      const outlet = await startAt(
        [
          {
            path: '/secret',
            component: 'test-shell-layout',
            canActivate: () => '/login',
            children: [
              {
                path: 'inner',
                component: 'test-never-loaded-view',
                load: () => {
                  loads += 1;
                  return Promise.resolve();
                },
              },
            ],
          },
          { path: '/login', component: 'test-login-view' },
        ],
        '/secret/inner',
      );
      await settled(present(outlet.firstElementChild));

      assert.equal(outlet.querySelector('.view')?.textContent, 'login');
      assert.equal(loads, 0, 'a denied section must not fetch what is inside it');
      assert.equal(built.shell, 0, 'nor mount its layout');
    });

    it('treats a parent with no component as a prefix and a guard only', async () => {
      let guarded = 0;
      const outlet = await startAt(
        [
          {
            path: '/area',
            canActivate: () => {
              guarded += 1;
              return true;
            },
            children: [{ path: 'page', component: 'test-child-a-view' }],
          },
        ],
        '/area/page',
      );
      await settleChain(present(outlet.firstElementChild));

      assert.equal(
        outlet.firstElementChild?.localName,
        'test-child-a-view',
        'a componentless level is transparent: its child renders in the router outlet',
      );
      assert.equal(guarded, 1);
    });

    it('re-runs a parent guard on every navigation inside it', async () => {
      let allowed = true;
      const outlet = await startAt(
        [
          {
            path: '/settings',
            component: 'test-shell-layout',
            canActivate: () => (allowed ? true : '/login'),
            children: [
              { path: 'users', component: 'test-child-a-view' },
              { path: 'roles', component: 'test-child-b-view' },
            ],
          },
          { path: '/login', component: 'test-login-view' },
        ],
        '/settings/users',
      );
      await settleChain(present(outlet.firstElementChild));

      allowed = false;
      await navigate('/settings/roles');
      await settled(present(outlet.firstElementChild));

      assert.equal(outlet.querySelector('.view')?.textContent, 'login');
      assert.equal(location.pathname, '/login');
    });

    it('finds the outlet in a layout rendered from an .html template', async () => {
      const outlet = await startAt(
        [
          {
            path: '/docs',
            component: 'test-templated-layout',
            children: [{ path: 'intro', component: 'test-child-a-view' }],
          },
        ],
        '/docs/intro',
      );
      await settleChain(present(outlet.firstElementChild));

      assert.equal(outlet.querySelector('.layout-label')?.textContent, 'templated');
      assert.equal(
        present(present(outlet.querySelector('x-route-outlet')).firstElementChild).localName,
        'test-child-a-view',
      );
    });

    it('reports a layout that renders no outlet', async () => {
      const host = mount('<div><main></main></div>');
      history.replaceState(null, '', '/broken/inner');

      await assert.rejects(
        () =>
          attachRouter(host, [
            {
              path: '/broken',
              component: 'test-outletless-layout',
              children: [{ path: 'inner', component: 'test-child-a-view' }],
            },
          ]),
        'contains no <x-route-outlet>',
      );
    });
  });
});
