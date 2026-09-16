# Application startup

An application's `main.js` is one call. The library owns the order of startup, and the
application supplies only the decisions that are its own.

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

There are two entry points, and one question picks between them. Does this application
mount micro-frontends?

`startApplication` from `@core/application/runtime.js` is the sequence itself.
`startHostedApplication` from `@host/runtime.js` is that sequence plus the default
`REMOTE_HOST` adapter, installed before the application's own `providers` hook so an
application with a different capability policy can still replace it. The example calls
the second because it mounts remotes. An application that mounts none calls the first and
never loads the host layer.

Every hook is optional, and each is awaited before the next runs.

| Step | What it is for |
|---|---|
| `configure` | Synchronous configuration that must precede everything, such as themes and the storage adapter |
| `manifest` | Fetch `app.manifest.json` and admit it as policy. The admitted copy is installed, never written to a global |
| `templates` | Warm the template cache from whichever key the manifest carries ([ADR-0081](../adr/0081-templates-are-delivered-by-chunk.md)) |
| `locale` | Awaited before first render, so nothing flashes untranslated |
| `providers` | The application's own injector bindings |
| `ready` | Anything that must settle before the root mounts, such as `AuthSession.init()` |
| `root` | Mount the root element, verifying that the module actually defined it |

## What the templates step does

The manifest carries one of three keys, and each starts the cache differently.

- `templateBundle` is fetched and seeded. A missing bundle makes the boot slower rather
  than failing it.
- `templateGroups`, which `--templates split` emits by default, has its `entry` group
  started rather than awaited, so the markup a first paint needs is in flight before the
  first component module evaluates. The other groups are registered here and each starts
  on the first `attachTemplate` out of its own chunk, which puts a group behind whatever
  guard stood in front of the code that names it.
- `templateFiles` is what a development manifest carries, because it has no chunks to
  group by. It is started whole.

Under `--templates split-lazy` the manifest carries none of them and the step does not
run.

## Reading the timings

The return value lists the steps that ran, each with the milliseconds it took.

```js
const started = await startHostedApplication({ /* … */ });
started.steps; // [{ name: 'configure', duration: 0.6 }, { name: 'manifest', duration: 3.4 }, …]
```

Every step also emits a `srl:startup:<step>` [User Timing][user-timing] measure, so a
profiler, a field beacon and the benchmark harness read the same durations without
holding this return value. A boot is seven steps deep, and until each published its own
number a regression inside one of them was invisible in the total
([ADR-0084](../adr/0084-a-startup-step-publishes-its-own-duration.md)).

## Failure

Any failure is rethrown as `ApplicationStartupError`, which names the step and keeps the
original error as `cause`. The root check goes through the same `@core/elements/mount.js`
path an outlet target, a route level and a remote root use, and takes its tag from the
class `load` resolved, so the page's root element and the startup spec cannot name two
different things.

[user-timing]: https://developer.mozilla.org/en-US/docs/Web/API/Performance_API/User_timing
