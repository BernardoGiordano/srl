import { currentPath } from '@core/navigation/router.js';
import { loadPreference, removePreference } from '@core/preferences/persistence.js';
import { assert, mount, present, settled, unmountAll } from '../../../lib/test/harness.js';

import '@components/shell/ui-app-shell.js';
import '@components/shell/ui-sidebar.js';
import '@components/shell/ui-sidebar-toggle.js';
import '@components/shell/ui-sidebar-group.js';
import '@components/shell/ui-sidebar-item.js';
import '@components/shell/ui-topbar.js';
import '@components/shell/ui-breadcrumb.js';
import '@components/shell/ui-avatar.js';
import '@components/shell/ui-menu.js';

/**
 * The layout collection, in real Chrome, against the real files.
 *
 * The harness comes from the library's own suite by relative path rather than
 * through a specifier: it is a test utility, not part of the framework's
 * public surface, and the dependency direction (components -> lib) is the
 * allowed one either way.
 *
 * `currentPath` is written to directly instead of driving the router. These
 * components consume the signal; how it came to hold a value is the router's
 * test, not theirs.
 */

/** @param {Element} element */
async function ready(element) {
  await settled(element);
  for (const child of element.querySelectorAll('*')) {
    const updatable = /** @type {{ updateComplete?: Promise<unknown> }} */ (child);
    if (updatable.updateComplete !== undefined) await updatable.updateComplete;
  }
}

describe('ui-sidebar', () => {
  afterEach(() => {
    unmountAll();
    removePreference('ui-sidebar', 'test.sidebar');
  });

  it('reflects its state as data-collapsed', async () => {
    const sidebar = /** @type {import('@components/shell/ui-sidebar.js').UiSidebar} */ (
      mount('<ui-sidebar><span>menu</span></ui-sidebar>')
    );
    await ready(sidebar);

    assert.notOk(sidebar.hasAttribute('data-collapsed'), 'starts expanded');

    sidebar.toggle();
    await ready(sidebar);
    assert.ok(sidebar.hasAttribute('data-collapsed'), 'collapsing must reach the DOM');

    sidebar.expand();
    await ready(sidebar);
    assert.notOk(sidebar.hasAttribute('data-collapsed'));
  });

  it('remembers the choice when given a storage key', async () => {
    const first = /** @type {import('@components/shell/ui-sidebar.js').UiSidebar} */ (
      mount('<ui-sidebar storage-key="test.sidebar"><span>menu</span></ui-sidebar>')
    );
    await ready(first);
    first.collapse();
    await ready(first);

    // The write is debounced and unmounting flushes it, which is what leaving the
    // page does. The key is a preference id, not a raw localStorage slot, so
    // an application that swaps the store swaps it for the sidebar too.
    unmountAll();
    const stored = /** @type {{ collapsed: boolean } | undefined} */ (
      loadPreference('ui-sidebar', 'test.sidebar', { schemaVersion: 1 })
    );
    assert.equal(stored?.collapsed, true);

    const second = /** @type {import('@components/shell/ui-sidebar.js').UiSidebar} */ (
      mount('<ui-sidebar storage-key="test.sidebar"><span>menu</span></ui-sidebar>')
    );
    await ready(second);

    assert.ok(second.collapsed, 'a reload must not forget');
    assert.ok(second.hasAttribute('data-collapsed'));
  });

  it('is driven by a toggle that finds it with closest()', async () => {
    const sidebar = /** @type {import('@components/shell/ui-sidebar.js').UiSidebar} */ (
      mount(`
        <ui-sidebar>
          <ui-sidebar-toggle label="Collapse"><span>x</span></ui-sidebar-toggle>
        </ui-sidebar>
      `)
    );
    await ready(sidebar);

    const button = present(sidebar.querySelector('ui-sidebar-toggle button'));
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    assert.equal(button.getAttribute('aria-label'), 'Collapse');

    /** @type {HTMLElement} */ (button).click();
    await ready(sidebar);

    assert.ok(sidebar.collapsed, 'the toggle must reach the sidebar above it');
    // The toggle owns no state: it re-renders because the sidebar's collapsed
    // state is a signal, which its render reads.
    assert.equal(
      present(sidebar.querySelector('ui-sidebar-toggle button')).getAttribute('aria-expanded'),
      'false',
    );
  });
});

describe('ui-sidebar-item', () => {
  afterEach(() => {
    currentPath.value = '/';
    unmountAll();
  });

  it('marks itself current for its own path and its subtree', async () => {
    currentPath.value = '/settings/users';
    const item = mount('<ui-sidebar-item href="/settings">Settings</ui-sidebar-item>');
    await ready(item);

    assert.ok(item.hasAttribute('data-active'), 'a section stays lit inside its subtree');
    assert.equal(present(item.querySelector('a')).getAttribute('aria-current'), 'page');
  });

  it('stops at its own path when exact', async () => {
    currentPath.value = '/settings/users';
    const item = mount('<ui-sidebar-item href="/settings" exact>Settings</ui-sidebar-item>');
    await ready(item);

    assert.notOk(item.hasAttribute('data-active'));
    // Absent, not "false": aria-current="false" announces the element as a
    // current item in some screen readers.
    assert.notOk(present(item.querySelector('a')).hasAttribute('aria-current'));
  });

  it('follows navigation without a subscription', async () => {
    currentPath.value = '/';
    const item = mount('<ui-sidebar-item href="/reports">Reports</ui-sidebar-item>');
    await ready(item);
    assert.notOk(item.hasAttribute('data-active'));

    currentPath.value = '/reports';
    await ready(item);
    assert.ok(item.hasAttribute('data-active'));
  });

  it('appends the active classes to the link, not to the host', async () => {
    currentPath.value = '/reports';
    const item = mount(
      '<ui-sidebar-item href="/reports" link-class="row" active-class="on">Reports</ui-sidebar-item>',
    );
    await ready(item);

    const link = present(item.querySelector('a'));
    assert.equal(link.getAttribute('class'), 'row on');
  });
});

describe('ui-sidebar-group', () => {
  afterEach(() => {
    currentPath.value = '/';
    unmountAll();
  });

  it('opens itself when the route is inside it', async () => {
    currentPath.value = '/settings/users';
    const group = mount(`
      <ui-sidebar-group match="/settings">
        <span slot="trigger">Settings</span>
        <div class="panel"><a href="/settings/users">Users</a></div>
      </ui-sidebar-group>
    `);
    await ready(group);

    assert.ok(group.hasAttribute('data-open'), 'a deep link must not land on a closed menu');
    assert.ok(group.querySelector('.panel'), 'the projected panel is rendered');
    assert.equal(present(group.querySelector('button')).getAttribute('aria-expanded'), 'true');
  });

  it('lets a click close a group the route opened', async () => {
    currentPath.value = '/settings/users';
    const group = mount(`
      <ui-sidebar-group match="/settings">
        <span slot="trigger">Settings</span>
        <div class="panel">rows</div>
      </ui-sidebar-group>
    `);
    await ready(group);

    /** @type {HTMLElement} */ (present(group.querySelector('button'))).click();
    await ready(group);

    assert.notOk(group.hasAttribute('data-open'), 'the human wins over the route');
    assert.notOk(group.querySelector('.panel'));
  });

  it('keeps projected node identity across close and reopen', async () => {
    const group = mount(`
      <ui-sidebar-group>
        <span slot="trigger">Settings</span>
        <div class="panel">rows</div>
      </ui-sidebar-group>
    `);
    await ready(group);

    const button = /** @type {HTMLElement} */ (present(group.querySelector('button')));
    button.click();
    await ready(group);
    const panel = present(group.querySelector('.panel'));

    button.click();
    await ready(group);
    assert.notOk(group.querySelector('.panel'), 'closing removes it from the document');

    button.click();
    await ready(group);
    assert.equal(
      group.querySelector('.panel'),
      panel,
      'reopening moves the same nodes back, never a clone',
    );
  });
});

describe('ui-breadcrumb', () => {
  afterEach(unmountAll);

  it('never links the last step, whatever the data says', async () => {
    const crumbs = /** @type {import('@components/shell/ui-breadcrumb.js').UiBreadcrumb} */ (
      mount('<ui-breadcrumb separator="/"></ui-breadcrumb>')
    );
    crumbs.items = [
      { label: 'Home', href: '/' },
      { label: 'Settings', href: '/settings' },
      { label: 'Users', href: '/settings/users' },
    ];
    await ready(crumbs);

    assert.equal(crumbs.querySelectorAll('li').length, 3);
    assert.equal(crumbs.querySelectorAll('a').length, 2, 'the current page is not a link');

    const current = present(crumbs.querySelector('span[aria-current]'));
    assert.equal(current.textContent?.trim(), 'Users');

    // One separator fewer than there are steps, and hidden from assistive tech.
    const separators = crumbs.querySelectorAll('span[aria-hidden="true"]');
    assert.equal(separators.length, 2);
  });
});

describe('ui-avatar', () => {
  afterEach(unmountAll);

  it('derives initials from the first two words', async () => {
    const avatar = mount('<ui-avatar name="Name Surname"></ui-avatar>');
    await ready(avatar);

    const fallback = present(avatar.querySelector('span[role="img"]'));
    assert.equal(fallback.textContent?.trim(), 'NS');
    assert.equal(fallback.getAttribute('aria-label'), 'Name Surname');
    assert.equal(fallback.getAttribute('data-ui-part'), 'avatar-fallback');
  });

  it('falls back to initials when the picture fails', async () => {
    const avatar = /** @type {import('@components/shell/ui-avatar.js').UiAvatar} */ (
      mount('<ui-avatar name="Ada Lovelace" src="/nothing-here.png"></ui-avatar>')
    );
    await ready(avatar);
    assert.ok(avatar.querySelector('img'), 'starts optimistic');

    avatar.onImageError();
    await ready(avatar);

    assert.notOk(avatar.querySelector('img'), 'a broken image glyph is worse than initials');
    assert.equal(present(avatar.querySelector('span[role="img"]')).textContent?.trim(), 'AL');
  });
});

describe('ui-menu', () => {
  afterEach(() => {
    currentPath.value = '/';
    unmountAll();
  });

  it('opens on the trigger and closes on a pointer outside it', async () => {
    const menu = /** @type {import('@components/shell/ui-menu.js').UiMenu} */ (
      mount(`
        <ui-menu label="Account">
          <span slot="trigger">avatar</span>
          <div class="panel">items</div>
        </ui-menu>
      `)
    );
    await ready(menu);

    const button = /** @type {HTMLElement} */ (present(menu.querySelector('button')));
    assert.equal(button.getAttribute('data-ui-part'), 'menu-trigger');
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.notOk(menu.querySelector('.panel'));

    button.click();
    await ready(menu);
    assert.ok(menu.querySelector('.panel'));
    assert.equal(
      present(menu.querySelector('div[id]')).getAttribute('data-ui-part'),
      'menu-panel',
    );
    // The component's own panel element, not the consumer's projected `.panel`
    // inside it: aria-controls has to name the region the trigger owns.
    assert.equal(
      present(menu.querySelector('button')).getAttribute('aria-controls'),
      present(menu.querySelector('div[id]')).id,
    );

    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await ready(menu);
    assert.notOk(menu.open, 'a click anywhere else dismisses it');
  });

  it('stays open for a pointer inside it', async () => {
    const menu = /** @type {import('@components/shell/ui-menu.js').UiMenu} */ (
      mount(`
        <ui-menu>
          <span slot="trigger">avatar</span>
          <div class="panel">items</div>
        </ui-menu>
      `)
    );
    await ready(menu);
    /** @type {HTMLElement} */ (present(menu.querySelector('button'))).click();
    await ready(menu);

    present(menu.querySelector('.panel')).dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true }),
    );
    await ready(menu);
    assert.ok(menu.open, 'clicking your own menu must not close it');
  });

  it('closes on Escape and on navigation', async () => {
    const menu = /** @type {import('@components/shell/ui-menu.js').UiMenu} */ (
      mount(`
        <ui-menu>
          <span slot="trigger">avatar</span>
          <div class="panel">items</div>
        </ui-menu>
      `)
    );
    await ready(menu);
    const button = /** @type {HTMLElement} */ (present(menu.querySelector('button')));

    button.click();
    await ready(menu);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await ready(menu);
    assert.notOk(menu.open);
    assert.equal(document.activeElement, button, 'focus returns to the trigger');

    button.click();
    await ready(menu);
    assert.ok(menu.open);

    currentPath.value = '/somewhere-else';
    await ready(menu);
    assert.notOk(menu.open, 'a menu left floating over the next page is the classic bug');
  });
});

describe('ui-app-shell', () => {
  afterEach(() => {
    currentPath.value = '/';
    unmountAll();
  });

  it('opens a drawer that closes on the backdrop, Escape and navigation', async () => {
    const shell = /** @type {import('@components/shell/ui-app-shell.js').UiAppShell} */ (
      mount(`
        <ui-app-shell backdrop-class="backdrop">
          <ui-sidebar slot="sidebar"><span>menu</span></ui-sidebar>
          <div class="body">
            <ui-sidebar-toggle for="drawer" label="Menu"><span>x</span></ui-sidebar-toggle>
          </div>
        </ui-app-shell>
      `)
    );
    await ready(shell);

    assert.notOk(shell.querySelector('.backdrop'));

    const button = /** @type {HTMLElement} */ (
      present(shell.querySelector('ui-sidebar-toggle button'))
    );
    button.click();
    await ready(shell);

    assert.ok(shell.hasAttribute('data-drawer-open'), 'the state is CSS-addressable');
    const backdrop = /** @type {HTMLElement} */ (present(shell.querySelector('.backdrop')));

    backdrop.click();
    await ready(shell);
    assert.notOk(shell.drawerOpen);

    button.click();
    await ready(shell);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await ready(shell);
    assert.notOk(shell.drawerOpen, 'Escape closes an overlay');

    button.click();
    await ready(shell);
    currentPath.value = '/elsewhere';
    await ready(shell);
    assert.notOk(shell.drawerOpen, 'and so does going somewhere');
  });

  it('hands the parent a queryable outlet before the parent has mounted', async () => {
    // The regression that made this rule exist. A projecting component captures
    // and removes its children on connect and puts them back on its first
    // render; if that render were asynchronous, the parent's own firstUpdated
    // would run against a subtree that is briefly in no document, and
    // `querySelector('main')` — how a shell finds its router outlet — would
    // return null with no error to explain it.
    const shell = mount(`
      <ui-app-shell>
        <ui-sidebar slot="sidebar"><span>menu</span></ui-sidebar>
        <div class="body"><main></main></div>
      </ui-app-shell>
    `);

    assert.ok(
      shell.querySelector('main'),
      'projected content must be in the document synchronously after connection',
    );
    await ready(shell);
  });
});
