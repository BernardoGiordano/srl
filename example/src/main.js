import { inject, provide } from '@core/foundation/inject.js';
import { configureTheme } from '@core/appearance/theme.js';
import { API_CLIENT, ApiClient } from '@core/http/client.js';
import { AUTH_SESSION, AuthSession } from '@auth/session.js';
import { sessionFetch } from '@auth/session-fetch.js';
import { startHostedApplication } from '@host/runtime.js';

import { SALES_SERVICE, SalesService } from './services/sales-service.js';
import { INVENTORY_SERVICE, InventoryService } from './services/inventory-service.js';
import { PEOPLE_SERVICE, PeopleService } from './services/people-service.js';
import { ADMIN_SERVICE, AdminService } from './services/admin-service.js';
import { LOOKUP_SERVICE, LookupService } from './services/lookup-service.js';
import { LIVE_FEED, LiveFeed } from './services/live-feed.js';
import { BffCookieTokenStore } from './auth/bff-cookie-store.js';
import { THEMES } from './theme.js';

/**
 * Entry point.
 *
 * The order of startup is not here, on purpose: it is identical in every
 * application, so it lives once in `@core/application/runtime.js`, which documents
 * each step and why it precedes the next. What is left is the set of decisions only
 * this application can make.
 *
 * `startHostedApplication` is that sequence plus the default micro-frontend host
 * adapter, which is what an application that mounts remotes would otherwise wire by
 * hand. This one mounts two.
 *
 * NO FAKE BACKEND
 *
 * There is no `fake-backend.js` here and nothing patches `fetch`. `example/server/`
 * is a real HTTP server — sessions in an HttpOnly cookie, server-side paging and
 * sorting, scope checks, an event stream — and the point of running one is that it
 * makes the recommended `bff` auth strategy demonstrable. A patched `fetch` cannot
 * set a cookie JavaScript may not read, so the strategy the library recommends was
 * the one the other examples could not show.
 *
 * Start it with `node example/server/server.mjs --open`.
 */

await startHostedApplication({
  /*
   * First, before the manifest is fetched: registering a theme after the first
   * render is a visible flash of the wrong palette, and the stored preference has
   * to be readable before anything paints.
   */
  configure: () => configureTheme({ defaultTheme: 'system', themes: THEMES }),

  providers: (manifest) => {
    /*
     * The session, and the store that backs it. The store is application code —
     * `src/auth/` holds this one and two alternatives — because it is the half
     * that knows `example/server/auth.mjs`: three paths, a JSON body, an
     * `X-CSRF-Token` header. The library knows none of that, which is what lets a
     * different application keep the same session machinery over a backend that
     * agrees with it about nothing.
     *
     * Nothing below this line knows which strategy is active. Swapping the store
     * for `MemoryTokenStore` or `DpopTokenStore` changes this one expression and
     * no line in any service.
     */
    provide(AUTH_SESSION, () => new AuthSession(new BffCookieTokenStore('/auth')));

    // One HTTP client, one base URL, from the manifest. The client is the
    // library's; what this application supplies is where the API is and that its
    // calls go out as the signed-in user.
    provide(API_CLIENT, () => new ApiClient(manifest.auth.apiBaseUrl, { fetch: sessionFetch }));

    // The domain services. Each takes the client and nothing else, which is what
    // keeps them testable without a browser and replaceable without a page.
    provide(SALES_SERVICE, () => new SalesService(inject(API_CLIENT)));
    provide(INVENTORY_SERVICE, () => new InventoryService(inject(API_CLIENT)));
    provide(PEOPLE_SERVICE, () => new PeopleService(inject(API_CLIENT)));
    provide(ADMIN_SERVICE, () => new AdminService(inject(API_CLIENT)));
    provide(LOOKUP_SERVICE, () => new LookupService(inject(API_CLIENT)));
    provide(LIVE_FEED, () => new LiveFeed(inject(API_CLIENT)));
  },

  /*
   * Resolved here rather than lazily inside a guard: a guard that races the session
   * restore is what bounces a refreshed deep link to the login page.
   */
  ready: () => inject(AUTH_SESSION).init(),

  // No tag: `load` resolves the root class, so startup reads the tag from that
  // component's own definition instead of holding a second copy of it.
  root: { load: () => import('./app-root.js').then((m) => m.AppRoot) },
});
