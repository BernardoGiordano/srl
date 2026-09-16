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
 * Keep the application shell mounted across child navigation. It derives visible
 * links, titles, and breadcrumbs from the navigation model and session scopes.
 * The live indicator follows the shared feed.
 */
export class ShellLayout extends SignalElement {
  /** @type {(() => void) | undefined} */
  #releaseFeed;

  /**
   * Build the sidebar from current scopes, translations, and remote entries.
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
     * Add remote links allowed by the manifest's permissions.
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

/** Whether the event stream is open. */
  get live() {
    return inject(LIVE_FEED).connected.value;
  }

  get liveCount() {
    return inject(LIVE_FEED).received.value;
  }

  /**
   * Translate the title for the current path. `HTMLElement` already owns `title`.
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

    // Groups are headings, not destinations.
    trail.push({ label: t(`nav.${found.group.key}`) });

    const leaf = found.leaf;
    if (leaf !== undefined) {
      trail.push({ label: t(`nav.${leaf.key}`), href: leaf.path });
      // Show the detail id as the current, unlinked step.
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
    // Keep one event stream open while the authenticated shell is mounted.
    this.#releaseFeed = inject(LIVE_FEED).retain();
  }

  onDestroy() {
    this.#releaseFeed?.();
    this.#releaseFeed = undefined;
  }
}

/**
 * Translate known detail path words and leave record ids as they are.
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
 * Find a remote label for a path outside the application navigation tree.
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
