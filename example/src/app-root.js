import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { attachRouter } from '@core/navigation/router.js';

import { createRoutes } from './routes.js';

/**
 * The root element, and deliberately almost nothing.
 *
 * Every other application in this repository puts its sidebar, header and
 * breadcrumb here. This one does not, because two of its routes must render
 * *without* chrome — `/login`, which nobody signed in reaches, and the standalone
 * error pages — and a shell that renders the chrome unconditionally then has to
 * hide it with a condition on every part of it.
 *
 * So the chrome is a route: `shell-layout.js` is a layout route whose children are
 * every screen inside the application, and it carries `requireSession` for all of
 * them at once. That is Angular's `AppComponent` holding only a `<router-outlet>`,
 * with the shell one level down, and it buys three things:
 *
 *   - one guard for the whole authenticated area, rather than one per leaf;
 *   - a login screen that is a full page rather than a page pretending the sidebar
 *     is not there;
 *   - the sidebar, the topbar and their state surviving every navigation inside the
 *     application, because a layout route outlives its children.
 *
 * `attachRouter` waits for the outlet itself, so nothing here has to know when
 * `<main>` exists.
 */
export class AppRoot extends SignalElement {
  onMount() {
    void attachRouter(this, createRoutes());
  }
}

await defineComponent({ tag: 'app-root', element: AppRoot, module: import.meta.url });
