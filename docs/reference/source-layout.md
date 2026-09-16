# Source layout

The repository contains two published packages, an example application, editor
clients, and the tools used only in this checkout. The dependency direction runs
from applications through components and host adapters into the core library.

| Directory | Purpose |
|---|---|
| `source/` | The `@srljs/core` package. Its `package.json` defines browser mounts, exports, and published files. |
| `source/lib/` | Framework modules, vendored browser dependencies, and the library's browser tests. Served at `/lib/`. |
| `source/components/` | Shared UI elements and styles. Served at `/components/`. |
| `cli/` | The `@srljs/cli` package. It provides the scaffold, project model, checks, dev server, language server, and release pipeline. |
| `example/` | Meridian, a complete application with a Node API, authentication, and two remotes. |
| `editors/` | VS Code and WebStorm clients for the CLI language server. |
| `tools/` | Verification, packaging, conformance, and benchmark tools used by this repository. |

## Library

`source/lib/core/` contains modules that do not depend on an application's
authentication policy.

| Path | Responsibility |
|---|---|
| `foundation/` | Signals, resources, injection, clocks, and JSON boundaries. |
| `template/` | The shared template grammar, expression parser, compiler, and security rules. |
| `elements/` | Component definitions, rendering, projection, mounting, and stylesheet scope. |
| `navigation/router.js` | Route matching, guards, nested layouts, and lazy loading. |
| `application/runtime.js` | Ordered application startup. |
| `remotes/mfe.js` | Remote contract, validation, and mount lifecycle. |
| `http/client.js` | API requests through an injected transport. |
| `preferences/persistence.js` | Synchronous UI preference storage. |
| `localization/i18n.js` | Message lookup and locale-aware formatting. |
| `appearance/theme.js` | Theme selection and document state. |
| `diagnostics/` | Update causes and a text report. |

`source/lib/auth/` owns sessions, refresh, guards, and an authenticated transport.
Applications supply token stores because their server endpoints differ.
`source/lib/host/` supplies the default remote host context and hosted startup.
Keeping those modules outside core lets an application replace the host policy.

The browser loads `source/lib/vendor/` directly. `npm run vendor` verifies its
committed files and notices. `source/lib/importmap.json` is the generated
fragment that applications include in their import maps.

`source/components/` groups UI elements by use. `shell/` holds the application
frame, `inputs/` holds form controls, `data/` holds tables and filters, and
`overlays/` holds the dialog. `style.css` supplies component defaults;
`theme-default.css` supplies an optional palette.

## Application

`example/index.html` declares the import map and development styles.
`example/app.manifest.json` names the API, locales, and remotes. The application
starts in `src/main.js` and declares routes in `src/routes.js`.

| Path | Responsibility |
|---|---|
| `example/src/auth/` | Memory, BFF cookie, and DPoP token stores. |
| `example/src/pages/` | Dashboard, sales, inventory, people, and settings screens. |
| `example/src/ui/` | Elements used by this application, such as cards, badges, and tabs. |
| `example/src/services/` | API adapters, lookups, and the live event feed. |
| `example/src/state/` | Shared order records retained by their readers. |
| `example/remotes/` | Billing and analytics modules with separate entries and translations. |
| `example/server/` | Node API, BFF authentication, SSE, and seeded in-memory data. |
| `example/test/` | Application tests and their fake server. |

The example uses relative imports inside `src/`. There is no shared `@app/`
mapping in the root tsconfig because that prefix could name only one
application's source directory.

## Toolchain

`cli/project-model/` parses application source once for the template checker,
message catalog, language server, and build. `cli/checks/` exposes the static
checks. `cli/origin/` resolves URLs against the same mounts for the dev server,
benchmark origin, and tests.

`cli/dev/` serves source and delivers edits to open pages. `cli/delivery/`
builds, verifies, stages, and activates artifacts. `cli/language-server/`
answers editor requests through the project model. `cli/scaffold/` writes the
files of a new application.

`tools/checks/` enforces this repository's dependency, package, and
documentation rules. `tools/benchmark/` measures performance. `tools/conformance/`
drives installed editor clients.

## Browser specifiers

| Specifier | Source directory | Browser mount |
|---|---|---|
| `@core/` | `source/lib/core/` | `/lib/core/` |
| `@auth/` | `source/lib/auth/` | `/lib/auth/` |
| `@host/` | `source/lib/host/` | `/lib/host/` |
| `@components/` | `source/components/` | `/components/` |

`source/package.json` declares these mounts. `cli/package/interface.mjs`
generates their import-map fragment, and the dev server and tests read the
same declaration.
