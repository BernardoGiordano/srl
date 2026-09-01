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
| `templates` | Warm the template cache from whichever key the manifest carries. `templateBundle` is fetched and seeded, and a missing bundle is a slower boot rather than a failure; `templateGroups`, which `--templates split` emits by default, has its `entry` group started rather than awaited, so the markup a first paint needs is in flight before the first component module evaluates; the other groups are registered here and each starts on the first `attachTemplate` out of its own chunk, which puts a group behind whatever guard stood in front of the code that names it. A development manifest has no chunks to group by and carries a flat `templateFiles`, which is started whole. Under `--templates split-lazy` the manifest carries neither and the step does not run ([ADR-0071](../adr/0071-a-built-template-is-fetched-by-the-component-that-needs-it.md), [ADR-0081](../adr/0081-the-manifest-names-every-template.md), [ADR-0086](../adr/0086-the-manifest-groups-templates-by-chunk.md), [ADR-0087](../adr/0087-a-template-group-starts-with-the-chunk-that-names-it.md)) |
| `locale` | Awaited before first render, so nothing flashes untranslated |
| `providers` | The application's own injector bindings |
| `ready` | Anything that must settle before the root mounts, such as `AuthSession.init()` |
| `root` | Mount the root element, verifying that the module actually defined it |

The return value lists the steps that ran, each with the milliseconds it took:

```js
const started = await startHostedApplication({ /* … */ });
started.steps; // [{ name: 'configure', duration: 0.6 }, { name: 'manifest', duration: 3.4 }, …]
```

Every step also emits a `srl:startup:<step>` [User Timing][user-timing] measure, which
is how a profiler, a field beacon and the benchmark harness read the same durations
without holding this return value. A boot is seven steps deep, and until each published
its own number a regression inside one of them was invisible in the total
([ADR-0084](../adr/0084-a-startup-step-publishes-its-own-duration.md)).

Any failure is rethrown as
`ApplicationStartupError`, naming the step and keeping the original error as `cause`.
The root check goes through the same `@core/elements/mount.js` path an outlet target,
a route level and a remote root use, and takes its tag from the class `load` resolved
— so the page's root element and the startup spec cannot name two different things.

[user-timing]: https://developer.mozilla.org/en-US/docs/Web/API/Performance_API/User_timing
