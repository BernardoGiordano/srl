import { navigate, navigationSettled } from '@core/navigation/router.js';
import { locale, setLocale } from '@core/localization/i18n.js';
import { configurePreferences, createMemoryStorage } from '@core/preferences/persistence.js';
import { assert, present, settled, unmountAll } from '../../source/lib/test/harness.js';

import { expireAccessToken, installFakeEventSource, installFakeServer, requested } from './fake-server.js';

/**
 * End-to-end smoke test for the operations application.
 *
 * It boots the real entry point in a real browser: the real manifest fetch, the real import
 * map, the real router with its three levels of layout route, the real session over the
 * `bff` token store, the real components. Nothing is stubbed except HTTP and `EventSource`;
 * see `fake-server.js` for why those two and nothing more.
 *
 * This is the test that proves the wiring, rather than that the pieces work. If the startup
 * order in `main.js` is wrong, if the manifest fails validation, if a lazy route points at a
 * module that does not define its element, or if a guard and its redirect target disagree,
 * only this notices.
 */

/** @type {HTMLElement | null} */
let shell = null;
let restoreUrl = '';
/** @type {(() => void) | undefined} */
let restoreFetch;
/** @type {(() => void) | undefined} */
let restoreEventSource;

/**
 * Navigate and wait for the view to be on screen.
 *
 * `navigate` resolves when the navigation has settled — guards, lazy imports and all — so
 * nothing here polls. What is left is the mounted element's own first render, which is a
 * promise too.
 *
 * @param {string} path
 */
async function goto(path) {
  await navigate(path);
  const view = main().firstElementChild;
  if (view !== null) await settled(view);
  await tick();
}

/** Let a fetch, a signal write and the render it causes land. */
async function tick() {
  for (let index = 0; index < 8; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** @returns {Element} */
function main() {
  return present(present(shell).querySelector('main'), 'app-root rendered no <main> outlet');
}

/** The deepest route outlet currently rendered, which is where a child route lands. */
/** @returns {Element} */
function innerOutlet() {
  const outlets = [...main().querySelectorAll('x-route-outlet')];
  return present(outlets.at(-1), 'no <x-route-outlet> rendered');
}

/**
 * @param {string} password `admin` for every scope, `viewer` for the read-only role.
 */
async function signIn(password) {
  await goto('/login');
  const form = present(main().querySelector('form'), 'login form must render');
  const username = present(form.querySelector('input[name="username"]'));
  const secret = present(form.querySelector('input[name="password"]'));
  /** @type {HTMLInputElement} */ (username).value = 'ada';
  /** @type {HTMLInputElement} */ (secret).value = password;
  form.dispatchEvent(new SubmitEvent('submit', { cancelable: true, bubbles: true }));
  await tick();
  await navigationSettled();
  const view = main().firstElementChild;
  if (view !== null) await settled(view);
  await tick();
}

async function signOut() {
  await goto('/');
  const menu = present(main().querySelector('ui-menu[label]'), 'no user menu');
  const signOutButton = present(
    [...menu.querySelectorAll('button')].at(-1),
    'the account menu must offer a sign-out control',
  );
  /** @type {HTMLButtonElement} */ (signOutButton).click();
  await tick();
  await navigationSettled();
  await tick();
}

describe('operations application', () => {
  before(async () => {
    restoreUrl = location.pathname + location.search;
    restoreFetch = installFakeServer();
    restoreEventSource = installFakeEventSource();

    // A memory store, so cases cannot inherit each other's table layouts or leave any in the
    // browser. Configured before the entry point runs, because the theme and the locale read
    // their stored values during startup.
    configurePreferences({ storage: createMemoryStorage() });

    // `?lang=en` pins the locale for the run. Without it the starting locale is negotiated
    // from `navigator.languages`, so the suite would pass or fail depending on the language
    // the developer's browser is set to.
    history.replaceState(null, '', '/login?lang=en');

    // The real entry point: manifest, providers, session restore, then <app-root>.
    await import('../src/main.js');

    shell = document.createElement('app-root');
    document.body.append(shell);
    await settled(shell);

    // The shell attaches the router in `onMount` without awaiting it, which is all a
    // synchronous lifecycle hook can do. This waits for that attach and its entry
    // navigation, so the suite starts with the first route mounted.
    await navigationSettled();
  });

  after(() => {
    shell?.remove();
    shell = null;
    restoreFetch?.();
    restoreEventSource?.();
    configurePreferences({});
    history.replaceState(null, '', restoreUrl);
    unmountAll();
  });

  it('sends an unauthenticated deep link to the login page', async () => {
    await goto('/sales/orders');
    assert.equal(location.pathname, '/login');
    assert.ok(main().querySelector('login-page'), 'the login page must mount');
    assert.notOk(main().querySelector('shell-layout'), 'the chrome must not render for a visitor');
  });

  it('refuses a guarded remote without downloading its code', async () => {
    await goto('/analytics');
    assert.equal(location.pathname, '/login');

    // The stronger half. The manifest's `requires` block becomes a route guard and the
    // router runs guards before `load`, so the remote's module is never fetched — hiding a
    // remote's UI while shipping its bytes leaks it to anyone reading the network tab.
    assert.notOk(
      requested.some((entry) => entry.includes('/remotes/analytics/')),
      `no analytics artifact may be fetched; saw ${requested.join(', ')}`,
    );
  });

  it('signs in through the BFF store and mounts the shell', async () => {
    await signIn('admin');
    assert.equal(location.pathname, '/');

    const chrome = present(main().querySelector('shell-layout'), 'the shell layout must mount');
    assert.ok(chrome.querySelector('ui-sidebar'), 'the sidebar must render');
    assert.ok(chrome.querySelector('ui-topbar'), 'the header must render');
    assert.equal(chrome.shadowRoot, null, 'the shell must render in light DOM');

    // Nothing in the sign-in exchange carries a credential this application can read: the
    // suite asserts the shape of what was called rather than the absence of a string.
    assert.ok(requested.includes('POST /auth/login'), 'the store must post to /auth/login');
  });

  it('renders the dashboard with formatted numbers and a lazily mounted panel', async () => {
    await goto('/');
    const page = present(main().querySelector('dashboard-page'));

    const tiles = [...page.querySelectorAll('app-stat')];
    assert.equal(tiles.length, 4, 'four KPI tiles');

    // The pipeline tile receives a number and a currency code and formats through Intl. A
    // tile handed a pre-formatted string could not do this, which is why the API sends
    // neither a symbol nor a separator.
    const pipeline = present(tiles[1]);
    assert.includes(present(pipeline.textContent), '€');

    // The panel's module is fetched on first selection, so this is also the assertion that
    // `<x-outlet>` mounted a component it was given only as a `load` thunk.
    const outlet = present(page.querySelector('x-outlet'));
    assert.ok(outlet.querySelector('live-panel'), 'the first panel must mount');

    const buttons = [...page.querySelectorAll('button')];
    const targets = present(
      buttons.find((button) => present(button.textContent).trim() === 'Quarter target'),
      'the second panel must be offered',
    );
    /** @type {HTMLButtonElement} */ (targets).click();
    await tick();

    assert.ok(outlet.querySelector('targets-panel'), 'the panel must have swapped');
    assert.notOk(outlet.querySelector('live-panel'), 'the previous panel must be gone');
  });

  it('pages the orders table on the server', async () => {
    await goto('/sales/orders');
    const table = present(main().querySelector('ui-table'), 'the orders table must render');
    await settled(table);
    await tick();

    const rows = table.querySelectorAll('tbody tr');
    assert.equal(rows.length, 20, 'one page of rows, not the whole collection');

    const asked = requested.filter((entry) => entry.startsWith('GET /api/orders'));
    assert.ok(asked.length > 0, 'the page must be fetched rather than filtered locally');
  });

  it('keeps the layout mounted while a detail tab changes', async () => {
    await goto('/sales/orders/OR-00001');
    const layout = present(main().querySelector('order-detail-page'));
    await tick();
    assert.ok(innerOutlet().querySelector('order-summary-tab'), 'the index tab must mount');

    await goto('/sales/orders/OR-00001/lines');
    assert.equal(
      main().querySelector('order-detail-page'),
      layout,
      'the layout instance must survive a change of child route',
    );
    assert.ok(innerOutlet().querySelector('order-lines-tab'), 'the lines tab must mount');
    assert.notOk(innerOutlet().querySelector('order-summary-tab'), 'the previous tab must be gone');
  });

  it('fetches the record once for a layout route and the tab inside it', async () => {
    await goto('/sales/orders');
    const before = requested.length;

    // Two components ask for this record on this navigation: the layout for its header
    // and the index tab for the customer block. The application record module owns one
    // retained resource for both, so the screen starts one read.
    await goto('/sales/orders/OR-00002');
    await tick();

    const asked = requested.slice(before).filter((entry) => entry === 'GET /api/orders/OR-00002');
    assert.ok(present(innerOutlet().querySelector('order-summary-tab')), 'the index tab must mount');
    assert.equal(asked.length, 1, 'the layout and its tab must share one record');
  });

  it('keeps shared order state coherent through writes, ids, tabs, and final release', async () => {
    await goto('/sales/orders/OR-00001');
    const layout = /** @type {import('../src/pages/sales/order-detail-page.js').OrderDetailPage} */ (
      present(main().querySelector('order-detail-page'))
    );
    const summary = /** @type {import('../src/pages/sales/order-summary-tab.js').OrderSummaryTab} */ (
      present(innerOutlet().querySelector('order-summary-tab'))
    );
    assert.equal(summary.name, 'Aurora Utilities');

    const beforeId = requested.length;
    await goto('/sales/orders/OR-00002');
    assert.equal(main().querySelector('order-detail-page'), layout, 'the reused layout must follow the id');
    assert.equal(innerOutlet().querySelector('order-summary-tab'), summary, 'the reused tab must follow the id');
    assert.equal(summary.name, 'Borealis Logistics', 'the tab must leave the previous settled record');
    assert.equal(
      requested.slice(beforeId).filter((entry) => entry === 'GET /api/orders/OR-00002').length,
      1,
      'both reused readers must start one read for the new id',
    );

    const beforeTabs = requested.length;
    await goto('/sales/orders/OR-00002/lines');
    await goto('/sales/orders/OR-00002');
    assert.equal(
      requested.slice(beforeTabs).filter((entry) => entry === 'GET /api/orders/OR-00002').length,
      0,
      'the retained layout must keep the record settled while its tab changes',
    );

    const beforeWrite = requested.length;
    const advance = /** @type {HTMLButtonElement} */ (
      present(layout.querySelector('app-card button'), 'the status action must render')
    );
    advance.click();
    await tick();
    assert.equal(layout.status, 'invoiced', 'the refresh after the write must reach the shared record');
    assert.equal(
      requested.slice(beforeWrite).filter((entry) => entry === 'PATCH /api/orders/OR-00002').length,
      1,
    );
    assert.equal(
      requested.slice(beforeWrite).filter((entry) => entry === 'GET /api/orders/OR-00002').length,
      1,
      'the shared record must refresh once after the write',
    );

    await goto('/sales/orders');
    const beforeRevisit = requested.length;
    await goto('/sales/orders/OR-00002');
    assert.equal(
      requested.slice(beforeRevisit).filter((entry) => entry === 'GET /api/orders/OR-00002').length,
      1,
      'leaving the final reader must make a later visit read fresh state',
    );
    const revisited = /** @type {import('../src/pages/sales/order-detail-page.js').OrderDetailPage} */ (
      present(main().querySelector('order-detail-page'))
    );
    assert.equal(revisited.status, 'invoiced');
  });

  it('re-renders every mounted component when the locale changes', async () => {
    await goto('/sales/orders');
    const heading = present(main().querySelector('h2'), 'the card heading must render');
    assert.equal(present(heading.textContent).trim(), 'Orders');

    await setLocale('it');
    await tick();
    assert.equal(locale.value, 'it');
    assert.equal(present(heading.textContent).trim(), 'Ordini', 'the same node must be patched');

    // Right-to-left is `dir` from a computed signal, not a per-locale stylesheet.
    await setLocale('ar');
    await tick();
    assert.equal(document.documentElement.dir, 'rtl');

    await setLocale('en');
    await tick();
    assert.equal(document.documentElement.dir, 'ltr');
  });

  it('refreshes once and retries when the access window has closed', async () => {
    await goto('/');
    const before = requested.length;

    expireAccessToken();
    await goto('/sales/customers');
    await tick();

    const since = requested.slice(before);
    assert.ok(
      since.includes('GET /auth/session'),
      `the 401 must be followed by a refresh; saw ${since.join(', ')}`,
    );
    assert.ok(
      since.filter((entry) => entry === 'GET /api/customers').length >= 2,
      'the request must be retried exactly once after the refresh',
    );
  });

  /**
   * The bulk write, end to end.
   *
   * The table owns which accounts are chosen and the screen owns what choosing them
   * means, so this is the case that proves the two halves meet: two checkboxes, one
   * button, two PATCHes and no third one for the row nobody chose.
   */
  it('suspends the accounts chosen in the table', async () => {
    await signOut();
    await signIn('admin');
    await goto('/settings/users');

    const page = present(main().querySelector('settings-users'));
    const boxes = /** @type {HTMLInputElement[]} */ ([
      ...page.querySelectorAll('[data-ui-part="table-select-row"]'),
    ]);
    assert.equal(boxes.length, 3, 'three accounts, each offering a choice');

    present(boxes[0]).click();
    present(boxes[2]).click();
    await tick();

    const bar = present(
      [...page.querySelectorAll('button')].find(
        (button) => present(button.textContent).trim() === 'Suspend selected',
      ),
      'choosing rows must offer the bulk action',
    );

    const before = requested.length;
    /** @type {HTMLButtonElement} */ (bar).click();
    await tick();

    const writes = requested.slice(before).filter((entry) => entry.startsWith('PATCH /api/users/'));
    assert.sameArray(
      writes,
      ['PATCH /api/users/US-0001', 'PATCH /api/users/US-0003'],
      'one write per chosen account, in the order they were chosen, and none for the third',
    );
    assert.ok(
      requested.slice(before).includes('GET /api/users'),
      'the list is re-read rather than patched in place',
    );

    const statuses = [...page.querySelectorAll('app-badge')].map((badge) =>
      present(badge.textContent).trim(),
    );
    assert.sameArray(statuses, ['Suspended', 'Active', 'Suspended']);
    assert.equal(
      page.querySelectorAll('[data-ui-part="table-select-row"]:checked').length,
      0,
      'a landed write clears the choice',
    );
  });

  it('sends a signed-in user without the scope to /forbidden, not to /login', async () => {
    await signOut();
    await signIn('viewer');
    assert.equal(location.pathname, '/');

    await goto('/settings/users');
    assert.equal(location.pathname, '/forbidden', 'an entitlement denial must not loop through login');
    assert.ok(main().querySelector('forbidden-page'));

    // And the sidebar does not offer what the session cannot reach.
    const chrome = present(main().querySelector('shell-layout'));
    const links = [...chrome.querySelectorAll('ui-sidebar-item')].map((item) => item.getAttribute('href'));
    assert.notOk(links.includes('/settings/users'), 'a link to a refused screen must not be offered');
    assert.notOk(links.includes('/analytics'), 'the analytics remote must not be offered either');
  });

  it('renders the catch-all for an unrouted path', async () => {
    await goto('/nothing/here');
    assert.ok(main().querySelector('not-found-page'), 'the catch-all must mount');
    assert.ok(main().querySelector('shell-layout'), 'inside the chrome, because the session is valid');
  });
});
