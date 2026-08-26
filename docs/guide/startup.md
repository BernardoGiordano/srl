# Application startup

An application's `main.js` is one call. The order of startup belongs to the library;
what an application supplies is the handful of decisions only it can make:

```js
import { startHostedApplication } from '@host/runtime.js';

await startHostedApplication({
  configure: () => configureTheme({ defaultTheme: 'system' }),
  providers: (manifest) => {
    provide(AUTH_SESSION, () => new AuthSession(new BffCookieTokenStore('/auth')));
  },
  ready: () => inject(AUTH_SESSION).init(),
  root: { load: () => import('./app-root.js').then((m) => m.AppRoot) },
});
```

Two entry points, and the choice is one question: does this application mount
micro-frontends? `startApplication` from `@core/application/runtime.js` is the
sequence itself. `startHostedApplication` from `@host/runtime.js` is that sequence
plus the default `REMOTE_HOST` adapter, installed before the application's own
`providers` hook so an application with a different capability policy can still
replace it. example calls the second, because it mounts remotes; an application that
mounts none calls the first and never loads the host layer.

Every hook is optional and each is awaited before the next runs. The steps, in order:

| Step | What it is for |
|---|---|
| `configure` | Synchronous configuration that must precede everything: themes, storage adapter |
| `manifest` | Fetch `app.manifest.json` and admit it as policy; the admitted copy is installed, never written to a global |
| `templates` | Seed the template cache from `manifest.templateBundle`, when an application configures one; a missing bundle is a slower boot, not a failure. A built artifact ships no bundle by default and each component fetches its own template ([ADR-0071](../adr/0071-a-built-template-is-fetched-by-the-component-that-needs-it.md)) |
| `locale` | Awaited before first render, so nothing flashes untranslated |
| `providers` | The application's own injector bindings |
| `ready` | Anything that must settle before the root mounts, such as `AuthSession.init()` |
| `root` | Mount the root element, verifying that the module actually defined it |

The return value lists the hooks that ran. Any failure is rethrown as
`ApplicationStartupError`, naming the step and keeping the original error as `cause`.
The root check goes through the same `@core/elements/mount.js` path an outlet target,
a route level and a remote root use, and takes its tag from the class `load` resolved
— so the page's root element and the startup spec cannot name two different things.
