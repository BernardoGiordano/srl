# Application startup

An application starts with one call in `main.js`. It supplies configuration and
providers; the library runs the startup steps in order.

```js
import { startHostedApplication } from '@srljs/core';

await startHostedApplication({
  configure: () => configureTheme({ defaultTheme: 'system' }),
  providers: () => {
    provide(AUTH_SESSION, () => new AuthSession(new BffCookieTokenStore('/auth')));
  },
  ready: () => inject(AUTH_SESSION).init(),
  root: { load: () => import('./app-root.js').then((m) => m.AppRoot) },
});
```

Use `startApplication` when an application has no remotes. `startHostedApplication` adds the default `REMOTE_HOST`
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

## The manifest

`app.manifest.json` sits beside `index.html`. Every section is optional, so an
application with one locale, no remotes and no API can ship this much.

```json
{
  "$schema": "../node_modules/@srljs/core/lib/core/remotes/app.manifest.schema.json",
  "i18n": { "defaultLocale": "en", "bundles": ["/i18n/{locale}.json"] }
}
```

| Section | Holds | When absent |
|---|---|---|
| `i18n` | `defaultLocale`, `supportedLocales`, `bundles` URL patterns | One locale, `en`, with no bundles |
| `auth` | `apiBaseUrl`, the root-relative base of the application API | `manifest.auth` is undefined |
| `remotes` | One entry per micro-frontend, described in [authentication and remotes](auth-and-remotes.md) | No remotes |
| `templateBundle`, `templateGroups`, `templateFiles` | Template delivery, written by `srl build` | Templates load on demand |

`defaultLocale` and `supportedLocales` stand in for each other. With only
`defaultLocale`, that locale is the only one supported. With only
`supportedLocales`, the first one is the default.

Admission refuses a key it does not know, so a misspelled section fails at
startup and does not read as an absent one. A key starting with `$` is an
annotation, as `$schema` and `$comment` are. A present section is checked in
full, and a bad value is refused, never replaced by its default.

`$schema` points an editor at the JSON Schema the library ships, which gives
completion and underlines a wrong key as you type. The schema is generated
from the admission policy. Admission still has the final word, because some
rules, such as the import map pin and two remotes on one mount, need the whole
document and the page.

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
