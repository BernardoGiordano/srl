# Application startup

An application starts with one call in `main.js`. It supplies configuration and
providers; the library runs the startup steps in order.

```js
import { startHostedApplication } from '@host/runtime.js';

await startHostedApplication({
  configure: () => configureTheme({ defaultTheme: 'system' }),
  providers: () => {
    provide(AUTH_SESSION, () => new AuthSession(new BffCookieTokenStore('/auth')));
  },
  ready: () => inject(AUTH_SESSION).init(),
  root: { load: () => import('./app-root.js').then((m) => m.AppRoot) },
});
```

Use `startApplication` from `@core/application/runtime.js` when an application
has no remotes. `startHostedApplication` adds the default `REMOTE_HOST`
provider before the application's providers run. The example uses it for its
remotes, and an application can replace that provider with its own policy.

Every hook is optional. The library awaits each step before moving to the next.

| Step | Work |
|---|---|
| `configure` | Apply synchronous settings such as themes and preference storage. |
| `manifest` | Fetch and admit `app.manifest.json`. |
| `templates` | Start loading templates according to the manifest. |
| `locale` | Load the initial language before rendering. |
| `providers` | Install application services in the injector. |
| `ready` | Settle work needed before mounting, such as session restoration. |
| `root` | Load, define, and mount the root element. |

## Template loading

The manifest chooses how templates enter the cache.

- `templateBundle` fetches a combined bundle. A missing bundle slows startup
  but does not stop it.
- `templateGroups` starts the entry group early. Other groups start when a
  component in their chunk first asks for a template.
- `templateFiles` starts the development templates without chunk grouping.

With `--templates split-lazy`, the manifest carries none of these keys and the
step has no template work.

## Timings and failure

The return value lists the steps that ran and their durations.

```js
const started = await startHostedApplication({ /* … */ });
started.steps; // [{ name: 'configure', duration: 0.6 }, …]
```

Each step also emits a `srl:startup:<step>`
[User Timing](https://developer.mozilla.org/en-US/docs/Web/API/Performance_API/User_timing)
measure. Profilers and benchmarks can read it without the return value.

`ApplicationStartupError` names the failed step and preserves the original
error as `cause`. Root mounting uses the same definition check as routes and
outlets.
