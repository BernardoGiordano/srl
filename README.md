<h1 align="center">srl</h1>

<p align="center">
  <strong>s</strong>ource <strong>r</strong>uns <strong>l</strong>ive — an Angular-inspired SDK for
  lightweight, buildless, reactive single-page applications.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@srljs/core"><img alt="npm" src="https://img.shields.io/npm/v/@srljs/core?label=%40srljs%2Fcore"></a>
  <a href="https://www.npmjs.com/package/@srljs/cli"><img alt="npm" src="https://img.shields.io/npm/v/@srljs/cli?label=%40srljs%2Fcli"></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="Node 22+" src="https://img.shields.io/badge/node-%3E%3D22-brightgreen">
</p>

<p align="center">
  <a href="https://srl-example.santella.dev">Live demo</a> ·
  <a href="docs/getting-started.md">Getting started</a> ·
  <a href="docs/guide/">Guide</a> ·
  <a href="docs/architecture.md">Architecture</a> ·
  <a href="docs/adr/">Decisions</a>
</p>

---

The browser loads your source files directly, through an import map. There is no bundler,
no transpiler and no watcher between the file you save and the page that runs it. You get
signals, a template dialect that is statically checked without a compiler, routing, forms,
i18n, auth and micro-frontends, plus a component collection built on all of it.

Optimisation is a separate, optional step. Minification, the template bundle and the
generated CSS all run at release time and preserve behaviour, so nothing in that pipeline
is required to run your application.

## Why

| | |
|---|---|
| **Nothing to install to run it** | The page loads `.js` and `.html` as they are on disk. `npm install` is for the tools. |
| **What you debug is what you wrote** | No source maps, no compiled output, no build step to reason about. |
| **Templates are checked anyway** | The checker and the language server read the same AST, so a typo in a binding is an error before it is a blank screen. |
| **Angular shapes, web platform primitives** | Custom elements, signals and the real DOM. `defineComponent`, `inject`, guards and outlets will look familiar. |
| **One decision per file** | The [decision records](docs/adr/) say why each seam sits where it does, cited from the source by number. |

## Live demo

The example application runs at **[srl-example.santella.dev](https://srl-example.santella.dev)**.

It is served as unminified source, the same files that sit in `example/` and `source/`,
loaded by the browser through an import map. Open devtools and every file the demo runs
reads exactly as it is checked into this repository.

## Install

**In a browser with an import map.** Serve the package's two directories from your origin
and paste the import-map fragment it publishes.

```html
<script type="importmap">
  <!-- node_modules/@srljs/core/lib/importmap.json -->
</script>
<script type="module" src="/src/main.js"></script>
```

```js
import { defineComponent } from '@core/elements/component.js';
import { UiAvatar } from '@components/shell/ui-avatar.js';
```

**In Node or a bundler**, where no import map exists, two pre-resolved bundles cover the
same surface.

```js
import { defineComponent, SignalElement } from '@srljs/core';
import { UiTable } from '@srljs/core/components';
```

[ADR-0066](docs/adr/0066-the-package-serves-two-audiences.md) explains why there are two
shapes and what the second one costs. The package's own README is
[source/README.md](source/README.md).

## Build and deploy

A repository that ships an application installs the toolchain beside the library.

```bash
npm install --save-dev @srljs/cli
srl new web          # the nine files a correct application is, written for you
srl serve --app web  # static dev server, watch and live reload
srl build --app web  # the production artifact, with its report
```

`@srljs/cli` is this repository's `cli/` directory, published separately. It holds the
scaffold, the dev server, the project model, the template checker, the language server and
the release pipeline. It is a second package because the build needs Vite, parse5 and tsc,
and a page that loads the framework as source must not have to install a bundler
([ADR-0067](docs/adr/0067-the-toolchain-is-a-second-package.md)). Its README is
[cli/README.md](cli/README.md).

## Run this repository

```bash
npm run example    # the example application, http://localhost:8100
npm run start      # any application, served statically, http://localhost:8000
```

Neither needs an install to serve the application, because the browser loads the files
directly. `npm install` is what the tools need — typecheck, lint, tests, benchmarks.

## A component, end to end

An application's `main.js` is one call.

```js
import { startHostedApplication } from '@host/runtime.js';

await startHostedApplication({
  configure: () => configureTheme({ defaultTheme: 'system' }),
  providers: () => provide(AUTH_SESSION, () => new AuthSession(new BffCookieTokenStore('/auth'))),
  ready: () => inject(AUTH_SESSION).init(),
  root: { load: () => import('./app-root.js').then((m) => m.AppRoot) },
});
```

A component is one declaration.

```js
import { defineComponent } from '@core/elements/component.js';
import { SignalElement } from '@core/elements/signal-element.js';
import { UiAvatar } from '@components/shell/ui-avatar.js';

export class UsersPage extends SignalElement {
  get rows() { return inject(USER_SERVICE).users; }       // returns the signal
  get isLoading() { return inject(USER_SERVICE).isLoading; }
  reload() { void inject(USER_SERVICE).reload(); }
}

await defineComponent({
  tag: 'users-page',
  element: UsersPage,
  module: import.meta.url,   // the template is this module's sibling .html
  uses: [UiAvatar],          // the elements this template names, as classes
});
```

Its template is the sibling `.html`, checked against the class without a build.

```html
<h1>{{ t('users.title') }}</h1>
<button [?disabled]="isLoading" (click)="reload()">{{ t('users.reload') }}</button>

<ui-avatar *for="user of rows; key: user.id" [name]="user.name"></ui-avatar>
```

More on [defining a component](docs/guide/components.md) and
[the template language](docs/guide/templates.md).

## Repository layout

| Directory | What it holds |
|---|---|
| `source/` | The published package, `@srljs/core`. Its own `package.json` declares what ships. |
| `source/lib/` | The framework — core, auth, host, vendored dependencies, its own suite. |
| `source/components/` | The shared collection, the frame of an internal application. |
| `example/` | The example application — four sections, auth over a real backend, micro-frontends, i18n. |
| `cli/` | The published toolchain, `@srljs/cli`. Scaffold, dev server, project model, checkers, build, release. |
| `editors/` | Thin VS Code and WebStorm clients over the toolchain's language server. |
| `tools/` | This repository's own tools, published nowhere — vendor refresh, bundle build, interface and docs checks, benchmarks. |

## Checks

```bash
npm run check          # typecheck, templates, lint, tool tests, vendor, package, verify, docs, browser tests
APP=example npm test   # the library, the collection and that application's suite
npm run benchmark:ci   # the performance gate, against the checked-in baseline
```

[Getting started](docs/getting-started.md) lists what each command refuses and what to run
after changing what.

## Documentation

The README is the interface. `docs/` is the manual, and `docs/adr/` is the reasoning.

| Where | What is in it |
|---|---|
| [Getting started](docs/getting-started.md) | Run, check, test, and what to run after changing X |
| [Architecture map](docs/architecture.md) | Glossary, the dependency rule, the seams and what proves each |
| [Invariants](docs/invariants.md) | What a change may not break, and the check that enforces it |
| [Guide](docs/guide/) | Startup, components, templates, routing, i18n, preferences, auth, the collection, performance, delivery, testing, browsers |
| [Editor support](docs/guide/editor-support.md) | VS Code, WebStorm and generic LSP setup; diagnostics, completion, navigation, refactoring |
| [Reference](docs/reference/) | The generated project index, the source layout, the Angular map |
| [Decision records](docs/adr/) | One decision per file, cited from source by number |

Every generated table comes from `cli/project-model/`, the single AST pass over the source
that the template checker, the dependency verifier and the template bundler also read.

```bash
npm run docs:check      # a generated table drifted from the source
npm run docs:write      # regenerate it
npm run docs:adr        # a malformed record, or a citation resolving to nothing
npm run docs:browsers   # the support matrix drifted from the recorded journey run
```

[The documentation policy](docs/documentation.md) says where each kind of knowledge
belongs, and it is itself enforced.

## License

MIT, in [LICENSE](LICENSE).

Three runtime dependencies are vendored into `source/lib/vendor` and redistributed here.
**lit** 3.3.3 (BSD-3-Clause), **@preact/signals-core** 1.14.4 (MIT) and, for development
only, **@tailwindcss/browser** 4.3.3 (MIT). Their notices are in
[source/lib/vendor/LICENSES.md](source/lib/vendor/LICENSES.md), where `npm run vendor`
checks them against the `LICENSE` of the pinned version in `node_modules`. Where each file
came from is recorded in
[source/lib/vendor/provenance.json](source/lib/vendor/provenance.json). A production
artifact carries its own generated `THIRD_PARTY_LICENSES.md` instead, and
[delivery](docs/guide/delivery.md#third-party-notices) describes both.

## Credits

Coworkers put the idea of a buildless SDK for faster prototyping in front of me a while
back. This is my shot at it, coming from Angular.

This SDK was designed, built and tested with help from AI coding assistants. The repository
is deliberately structured to read well for both humans and coding assistants, which is why
the decision records are as prominent as the guides.
