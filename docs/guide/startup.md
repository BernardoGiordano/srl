# Application startup

An application starts with one call in `main.js`. It supplies configuration and
providers; the library runs the startup steps in order.

```js
import {
  AUTH_SESSION,
  AuthSession,
  configureTheme,
  inject,
  provide,
  startHostedApplication,
} from '@srljs/core';

import { CookieTokenStore } from './auth/cookie-token-store.js';

await startHostedApplication({
  configure: () => configureTheme({ defaultTheme: 'system' }),
  providers: () => {
    provide(AUTH_SESSION, () => new AuthSession(new CookieTokenStore('/auth')));
  },
  ready: () => inject(AUTH_SESSION).init(),
  root: { load: () => import('./app-root.js').then((m) => m.AppRoot) },
});
```

`CookieTokenStore` stands for the application's own token store. The library
ships none, because a store holds one backend's endpoints and field names.
[Authentication and remotes](auth-and-remotes.md) describes the interface, and
the example application carries three stores to adapt.

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
error as `cause`. Its `code` is `runtime/startup`. Root mounting uses the same
definition check as routes and outlets.

## Failures during development

`srl serve` prints what fails in the page, so a blank page has a reason in the
terminal. The page reports four kinds of failure.

| Code | Severity | Cause |
|---|---|---|
| `runtime/startup` | error | A startup step failed. |
| `runtime/module-load` | error | A module, or one it imports, did not load. |
| `runtime/uncaught` | error | An error with no code of its own reached the page. |
| `runtime/unknown-binding` | warning | A template read a name nothing answers. |

An error whose `cause` carries a catalogued code is printed under that code,
such as `templates/expression-syntax` for a binding that does not parse. Each
line names the file the failing URL is served from. Errors also appear in a
panel at the bottom of the page.

```text
  FAIL runtime/startup  node_modules/@srljs/core/lib/core/application/runtime.js:156:11: Application startup failed at step "manifest": /app.manifest.json has a key admission does not know, "remots". …
```

A startup failure is thrown inside the library, so its place is the library's
file, and the message names the step and the cause.

The reporting is injected by the development server. The file on disk and the
production build carry none of it. A suite or a staging build can install its
own reporter for unknown names with `reportUnknownNames` from `@srljs/core`.
