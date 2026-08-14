import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { computed } from '@core/foundation/reactive.js';
import { inject } from '@core/foundation/inject.js';
import { currentPath, navigate, RouteOutlet } from '@core/navigation/router.js';
import { availableLocales, locale, setLocale, t } from '@core/localization/i18n.js';
import { availableThemes, setTheme, theme } from '@core/appearance/theme.js';
import { manifest } from '@core/remotes/mfe.js';
import { AUTH_SESSION } from '@auth/session.js';

import { UiAppShell } from '@components/shell/ui-app-shell.js';
import { UiSidebar } from '@components/shell/ui-sidebar.js';
import { UiSidebarToggle } from '@components/shell/ui-sidebar-toggle.js';
import { UiSidebarGroup } from '@components/shell/ui-sidebar-group.js';
import { UiSidebarItem } from '@components/shell/ui-sidebar-item.js';
import { UiTopbar } from '@components/shell/ui-topbar.js';
import { UiBreadcrumb } from '@components/shell/ui-breadcrumb.js';
import { UiAvatar } from '@components/shell/ui-avatar.js';
import { UiMenu } from '@components/shell/ui-menu.js';

import { NAVIGATION, locate } from '../navigation.js';
import { iconPath } from '../icons.js';
import { LIVE_FEED } from '../services/live-feed.js';

/** @import { NavNode } from '../navigation.js' */

/**
 * The application chrome, as a layout route.
 *
 * Every screen inside the application is a child of this route, so this element is
 * mounted once per sign-in and outlives every navigation under it: the sidebar's
 * collapse state, the drawer, the scroll position of the nav and the live connection
 * all survive moving between screens, with nothing persisted and nothing restored.
 *
 * Three things are computed here rather than stored anywhere:
 *
 *  - **the visible navigation**, from the model in `../navigation.js` intersected with
 *    the session's scopes, plus whatever the manifest contributes as remotes. Offering
 *    a link that lands on `/forbidden` is worse than not offering it;
 *  - **the page title and the breadcrumb**, from `currentPath` and the same model. No
 *    route carries a `data: { title }` block and no screen sets a title, so a screen
 *    cannot forget to;
 *  - **the live indicator**, from the feed's own signals.
 *
 * Everything visual is `source/components` plus Tailwind utility classes. Nothing in
 * this file knows how a sidebar collapses, how a drawer closes on navigation or how an
 * accordion decides it is open, and nothing in `source/components` knows this
 * application exists.
 */
export class ShellLayout extends SignalElement {
  /** @type {(() => void) | undefined} */
  #releaseFeed;

  /**
   * The sidebar's tree: this application's sections, then the remotes.
   *
   * A computed signal, because both inputs are reactive — the scopes come from the
   * session and the labels from the message table — so a locale change relabels the
   * menu and a logged-in scope change reshapes it, with no subscription here.
   *
   * @type {import('@core/foundation/types.js').ReadonlySignal<ReadonlyArray<NavNode>>}
   */
  #sections = computed(() => {
    const scopes = inject(AUTH_SESSION).scopes.value;
    /** @param {NavNode} node */
    const permitted = (node) => node.scope === undefined || scopes.includes(node.scope);

    const own = NAVIGATION.map((group) => ({
      ...group,
      children: (group.children ?? []).filter(permitted),
    })).filter((group) => group.children.length > 0);

    /*
     * The remotes, from the manifest. `nav.<name>` is the message key, which is the
     * whole of what a shell has to add for a micro-frontend: no route, no import, no
     * component. `requires.permissions` is read here only to decide whether to offer
     * the link — the guard the router runs is built from the same block, so a typed
     * URL is refused whatever this list says.
     */
    const remotes = manifest().remotes.filter((remote) =>
      (remote.requires.permissions ?? []).every((permission) => scopes.includes(permission)),
    );

    if (remotes.length === 0) return own;

    return [
      ...own,
      {
        key: 'apps',
        path: '/apps',
        icon: 'analytics',
        children: remotes.map((remote) => ({ key: remote.name, path: remote.mount })),
      },
    ];
  });

  get sections() {
    return this.#sections.value;
  }

  get userName() {
    return inject(AUTH_SESSION).session.value?.name ?? '';
  }

  /** The role label, from the scopes the session actually carries. */
  get roleKey() {
    const scopes = inject(AUTH_SESSION).scopes.value;
    if (scopes.includes('users:write')) return 'role.administrator';
    if (scopes.includes('sales:write')) return 'role.operator';
    return 'role.viewer';
  }

  get localeCode() {
    return locale.value;
  }

  get locales() {
    return availableLocales.value;
  }

  get themeName() {
    return theme.value;
  }

  get themes() {
    return availableThemes.value.map((name) => ({ name, label: t(`theme.${name}`) }));
  }

  /** True while the event stream is open. Rendered as a dot, not as a sentence. */
  get live() {
    return inject(LIVE_FEED).connected.value;
  }

  get liveCount() {
    return inject(LIVE_FEED).received.value;
  }

  /**
   * The title of the current screen.
   *
   * Reads `currentPath`, so it follows navigation with no subscription, and `t()`, so
   * it follows a language change. Not called `title`: `HTMLElement.title` is taken,
   * and tsc says so.
   */
  get pageTitle() {
    const path = currentPath.value;
    if (path === '/') return t('nav.dashboard');
    const found = locate(path);
    if (found === undefined) return remoteTitle(path) ?? t('page.notFound');
    return t(`nav.${(found.leaf ?? found.group).key}`);
  }

  /** @returns {Array<{ label: string, href?: string }>} */
  get breadcrumbs() {
    const path = currentPath.value;
    /** @type {Array<{ label: string, href?: string }>} */
    const trail = [{ label: t('nav.dashboard'), href: '/' }];
    if (path === '/') return trail;

    const found = locate(path);
    if (found === undefined) {
      const remote = remoteTitle(path);
      trail.push({ label: remote ?? t('page.notFound') });
      return trail;
    }

    // No href on the group: a section is a heading in this model, not a page. A
    // breadcrumb that links to a redirect is fine; one that links to a 404 is not.
    trail.push({ label: t(`nav.${found.group.key}`) });

    const leaf = found.leaf;
    if (leaf !== undefined) {
      trail.push({ label: t(`nav.${leaf.key}`), href: leaf.path });
      // A detail route is inside its list's leaf, so the identifier is the trail's
      // last step and is not a link: it is where we already are.
      const rest = path.slice(leaf.path.length).replace(/^\/|\/$/gu, '');
      const identifier = rest.split('/')[0];
      if (identifier !== undefined && identifier !== '') trail.push({ label: segmentLabel(identifier) });
    }
    return trail;
  }

  /** @param {string | undefined} name */
  iconPath(name) {
    return iconPath(name);
  }

  /** @param {Event} event */
  selectLocale(event) {
    if (event.target instanceof HTMLSelectElement) void setLocale(event.target.value);
  }

  /** @param {Event} event */
  selectTheme(event) {
    if (event.target instanceof HTMLSelectElement) setTheme(event.target.value);
  }

  signOut() {
    void inject(AUTH_SESSION)
      .logout()
      .then(() => navigate('/login'));
  }

  onMount() {
    // One connection for the whole authenticated area, held by the layout rather
    // than by the two screens that display it: both are inside this route, so the
    // stream stays open across a navigation between them instead of closing and
    // reopening.
    this.#releaseFeed = inject(LIVE_FEED).retain();
  }

  onDestroy() {
    this.#releaseFeed?.();
    this.#releaseFeed = undefined;
  }
}

/**
 * The last step of a detail path, which is usually an identifier and occasionally a
 * word.
 *
 * `/sales/orders/SO-1042` ends in data and is shown as it is; `/sales/customers/new`
 * ends in a keyword the route table chose, and showing that raw puts an English
 * fragment in the trail of every locale. A message under `breadcrumb.` is the
 * difference, and `t()` returning the key for anything unlisted is what keeps
 * identifiers out of the bundle.
 *
 * @param {string} segment
 * @returns {string}
 */
function segmentLabel(segment) {
  const key = `breadcrumb.${segment}`;
  const message = t(key);
  return message === key ? segment : message;
}

/**
 * A remote's label, for a path this application's navigation model does not own.
 *
 * @param {string} path
 * @returns {string | undefined}
 */
function remoteTitle(path) {
  const remote = manifest().remotes.find(
    (candidate) => path === candidate.mount || path.startsWith(`${candidate.mount}/`),
  );
  return remote === undefined ? undefined : t(`nav.${remote.name}`);
}

await defineComponent({
  tag: 'shell-layout',
  element: ShellLayout,
  module: import.meta.url,
  uses: [
    UiAppShell,
    UiSidebar,
    UiSidebarToggle,
    UiSidebarGroup,
    UiSidebarItem,
    UiTopbar,
    UiBreadcrumb,
    UiAvatar,
    UiMenu,
    RouteOutlet,
  ],
});
