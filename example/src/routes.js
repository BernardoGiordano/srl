import { remoteRoutes } from '@core/remotes/mfe.js';
import { requireScope, requireSession } from '@auth/guard.js';

import { LoginPage } from './pages/login-page.js';
import { NotFoundPage } from './pages/not-found-page.js';

/** @import { RouteDef } from '@core/navigation/types.js' */

/**
 * The route table. Angular's `Routes`, and every kind of entry it has appears here
 * once:
 *
 *   eager          `component` on a class this module imported. Two of them: the
 *                  login screen and the not-found page, because a route table that
 *                  needs a network request to tell you a URL is wrong is worse than
 *                  one that costs two kilobytes.
 *   lazy           `load` resolving the class, Angular's `loadComponent`. Everything
 *                  else. No entry names a tag — the class carries it.
 *   layout         a parent with a component: `shell-layout` and the two detail
 *                  screens. It stays mounted while its children come and go.
 *   componentless  a parent with children and no component: `sales`, `inventory`,
 *                  `people`. It contributes a path prefix and nothing else, which is
 *                  what a section without a page of its own is.
 *   guarded        `canActivate`, once per section rather than once per leaf.
 *   redirect       a child with `path: ''`, because a section URL has to land
 *                  somewhere.
 *   remote         contributed by the manifest, mounted at a path prefix, and loaded
 *                  on first navigation into it.
 *   catch-all      last, as it must be: first match wins.
 *
 * THE SHAPE WORTH LOOKING AT
 *
 * Nearly everything is a child of one route whose path is `''`: the shell, whose
 * `canActivate` is the only place `requireSession` appears. Scope guards sit on the
 * leaves that need more than a session and are an affordance rather than the
 * boundary — the server enforces the same scope on every request. ADR-0065.
 *
 * @returns {RouteDef[]}
 */
export function createRoutes() {
  return [
    // Outside the shell: the one route a signed-out visitor is allowed to render.
    { path: '/login', component: LoginPage },

    {
      path: '',
      load: () => import('./pages/shell-layout.js').then((m) => m.ShellLayout),
      canActivate: requireSession,
      children: [
        { path: '', load: () => import('./pages/dashboard-page.js').then((m) => m.DashboardPage) },

        /* ── Sales ────────────────────────────────────────────────────────── */
        {
          path: 'sales',
          children: [
            { path: '', redirect: '/sales/orders' },
            {
              path: 'orders',
              load: () => import('./pages/sales/orders-page.js').then((m) => m.OrdersPage),
              canActivate: requireScope('sales:read'),
            },
            {
              // A layout of its own: the order's header stays mounted while the
              // three tabs replace each other, so switching tabs neither refetches
              // the order nor loses the scroll position.
              path: 'orders/:id',
              load: () => import('./pages/sales/order-detail-page.js').then((m) => m.OrderDetailPage),
              canActivate: requireScope('sales:read'),
              children: [
                { path: '', load: () => import('./pages/sales/order-summary-tab.js').then((m) => m.OrderSummaryTab) },
                { path: 'lines', load: () => import('./pages/sales/order-lines-tab.js').then((m) => m.OrderLinesTab) },
                { path: 'history', load: () => import('./pages/sales/order-history-tab.js').then((m) => m.OrderHistoryTab) },
              ],
            },
            {
              path: 'customers',
              load: () => import('./pages/sales/customers-page.js').then((m) => m.CustomersPage),
              canActivate: requireScope('sales:read'),
            },
            /*
             * One customer, three modes, two routes. Creating is its own URL because
             * there is no record to name; reading and editing are the same URL, and
             * `?edit=true` is what separates them — a query change on a matched route
             * is a re-render rather than a navigation, so the form the user is looking
             * at becomes editable instead of being fetched again.
             *
             * That puts the entitlement in two places rather than one. `customers/new`
             * is still a guarded route, because a create has nothing to show a reader.
             * `customers/:id` is guarded for *reading*, and the edit affordance inside
             * it is what checks `sales:write` — a query parameter cannot be a route
             * guard. The server refuses the write either way; the guard is usability
             * and `example/server/api.mjs` is the boundary.
             *
             * `customers/new` precedes `customers/:id` because they collide: `new`
             * would otherwise bind as an id, and first match wins.
             */
            {
              path: 'customers/new',
              load: () => import('./pages/sales/customer-detail-page.js').then((m) => m.CustomerDetailPage),
              canActivate: requireScope('sales:write'),
              canDeactivate: confirmUnsavedCustomer,
            },
            {
              path: 'customers/:id',
              load: () => import('./pages/sales/customer-detail-page.js').then((m) => m.CustomerDetailPage),
              canActivate: requireScope('sales:read'),
              canDeactivate: confirmUnsavedCustomer,
            },
          ],
        },

        /* ── Inventory ────────────────────────────────────────────────────── */
        {
          path: 'inventory',
          canActivate: requireScope('inventory:read'),
          children: [
            { path: '', redirect: '/inventory/products' },
            { path: 'products', load: () => import('./pages/inventory/products-page.js').then((m) => m.ProductsPage) },
            { path: 'movements', load: () => import('./pages/inventory/movements-page.js').then((m) => m.MovementsPage) },
            { path: 'warehouses', load: () => import('./pages/inventory/warehouses-page.js').then((m) => m.WarehousesPage) },
          ],
        },

        /* ── People ───────────────────────────────────────────────────────── */
        {
          path: 'people',
          canActivate: requireScope('people:read'),
          children: [
            { path: '', redirect: '/people/employees' },
            { path: 'employees', load: () => import('./pages/people/employees-page.js').then((m) => m.EmployeesPage) },
            {
              path: 'employees/:id',
              load: () => import('./pages/people/employee-detail-page.js').then((m) => m.EmployeeDetailPage),
              children: [
                { path: '', load: () => import('./pages/people/employee-profile-tab.js').then((m) => m.EmployeeProfileTab) },
                { path: 'contracts', load: () => import('./pages/people/employee-contracts-tab.js').then((m) => m.EmployeeContractsTab) },
                { path: 'documents', load: () => import('./pages/people/employee-documents-tab.js').then((m) => m.EmployeeDocumentsTab) },
              ],
            },
            { path: 'teams', load: () => import('./pages/people/teams-page.js').then((m) => m.TeamsPage) },
          ],
        },

        /* ── Settings ─────────────────────────────────────────────────────── */
        {
          path: 'settings',
          load: () => import('./pages/settings/settings-layout.js').then((m) => m.SettingsLayout),
          children: [
            { path: '', redirect: '/settings/profile' },
            { path: 'profile', load: () => import('./pages/settings/settings-profile.js').then((m) => m.SettingsProfile) },
            { path: 'appearance', load: () => import('./pages/settings/settings-appearance.js').then((m) => m.SettingsAppearance) },
            {
              path: 'users',
              load: () => import('./pages/settings/settings-users.js').then((m) => m.SettingsUsers),
              canActivate: requireScope('users:read'),
            },
            {
              path: 'audit',
              load: () => import('./pages/settings/settings-audit.js').then((m) => m.SettingsAudit),
              canActivate: requireScope('audit:read'),
            },
          ],
        },

        /*
         * The micro-frontends, inside the shell so they get the sidebar and the
         * header like every other screen. Their paths, their guards and their
         * grants all come from app.manifest.json; this line is the whole of the
         * shell's knowledge of them.
         */
        ...remoteRoutes(),

        /*
         * Where every permission denial lands: `requireScope` above, and the mount
         * guards the manifest's `requires` blocks become. Not guarded itself beyond
         * the session, and it says nothing about what was missing — a page that
         * enumerated the entitlement someone lacks is a page that tells them what to
         * ask for, which is not always the intention.
         */
        { path: 'forbidden', load: () => import('./pages/forbidden-page.js').then((m) => m.ForbiddenPage) },

        { path: '*', component: NotFoundPage },
      ],
    },
  ];
}

/**
 * Let the customer form decide whether it may be left.
 *
 * Written here rather than as a method the router calls by name, because the
 * question belongs to the route: the same component behind a route that did not
 * want the prompt would not get one. The screen answers it — synchronously with
 * `true` when there is nothing unsaved, and otherwise with a promise it resolves
 * when the user has answered the prompt it renders.
 *
 * The `import` is inside the guard on purpose. Naming the class at the top of
 * this module would fetch the form's code during startup and undo the `load`
 * three lines above it; by the time a level can be *deactivated* its module is
 * already in the module map, so this resolves from cache and costs a microtask.
 * That buys a real `instanceof`, which is what stops a renamed method from
 * quietly turning the guard into "yes, always".
 *
 * @type {import('@core/navigation/types.js').DeactivateGuard}
 */
async function confirmUnsavedCustomer({ element }) {
  if (element === null) return true;
  const { CustomerDetailPage } = await import('./pages/sales/customer-detail-page.js');
  return element instanceof CustomerDetailPage ? element.canLeave() : true;
}
