# srl

**srl** (**s**ource **r**uns **l**ive) is an Angular inspired SDK to create lightweight, buildless and reactive SPAs.

Development stays usable without a persistent compiler, while production optimisation and static verification remain optional, deterministic steps.

Everything expensive is opt-in and behaviour-preserving: the CSS generation step, the template bundle, a comment strip. Nothing is required to run the application.

**Note**: this SDK has been designed, built and tested with some help from AI coding assistants. This repository is structured to serve as insightful documentation for both humans and AI coding assistants, to speed up the generation and the prototyping of new software.

## Live demo

The example application runs at **[srl-example.santella.dev](https://srl-example.santella.dev)**.

It is served as vanilla, unminified source: the same files that are in `example/` and
`source/`, loaded directly by the browser through an import map. No bundler, no minifier,
no transpiler in between, so every file the demo runs is readable in the browser's
devtools exactly as it is checked into this repository.

## Repository structure

```
source/             the published package, @srljs/core: its own package.json declares
                    what it publishes, and extracting it is a file move
source/lib/         the framework: core, auth, host, vendored deps, its own suite
source/components/  the shared collection: the frame of an internal application
example/            the example application: four sections, auth over a real backend,
                    micro-frontends, i18n
cli/                the published toolchain, @srljs/cli: dev server, project model,
                    template checker, artifact build and release. Its own package.json,
                    the same way source/ has one
tools/              this repository's own tools, published nowhere: the vendor refresh,
                    the bundle build, the interface and docs checks, the benchmarks
```

## Install it

Two shapes, and the first is the point.

```html
<!-- a browser with an import map: serve the package's lib/ and components/, paste
     node_modules/@srljs/core/lib/importmap.json, and import @core/… as the library does -->
```

```js
// Node or a bundler, which have no import map: two pre-resolved bundles
import { defineComponent, SignalElement } from '@srljs/core';
import { UiTable } from '@srljs/core/components';
```

Why there are two, and what the second costs, is
[ADR-0066](docs/adr/0066-the-registry-consumer-gets-bundles.md). The package's own README
is [source/README.md](source/README.md), and what changed between versions is
[the changelog](CHANGELOG.md).

A repository that *deploys* an application installs the toolchain beside the library, and
then owns none of it:

```bash
npm install --save-dev @srljs/cli
srl build --app web
```

`@srljs/cli` is this repository's `cli/` directory, published: the dev server, the project
model, the template checker, the artifact build and the release pipeline. It is separate
from the library because the build needs Vite, parse5 and tsc, and a page that loads the
framework as source must not have to install a bundler
([ADR-0067](docs/adr/0067-the-toolchain-is-a-second-package.md)). Its README is
[cli/README.md](cli/README.md).

## Run it

```bash
npm run example                                 # the application, http://localhost:8100
node cli/dev/serve.mjs --open                   # any application, statically, http://localhost:8000
```

Nothing is installed to run the application: the browser loads the files directly.
`npm install` is for the tools — typecheck, lint, tests, benchmarks.

Full walkthrough: [getting started](docs/getting-started.md).

## A component, end to end

An application's `main.js` is one call:

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

A component is one declaration:

```js
import { defineComponent } from '@core/elements/component.js';
import { UiCard } from '@app/ui/ui-card.js';

export class UsersPage extends SignalElement {
  get rows() { return inject(USER_SERVICE).users; }       // returns the signal
  get isLoading() { return inject(USER_SERVICE).isLoading; }
  reload() { void inject(USER_SERVICE).reload(); }
}

await defineComponent({
  tag: 'users-page',
  element: UsersPage,
  module: import.meta.url,   // the template is this module's sibling .html
  uses: [UiCard],            // the elements this template names, as classes
});
```

Its template is the sibling `.html`, and it is checked against the class without a
build:

```html
<h1>{{ t('users.title') }}</h1>
<button [?disabled]="isLoading" (click)="reload()">{{ t('users.reload') }}</button>

<ui-card *for="user of rows; key: user.id">{{ user.name }}</ui-card>
```

The repo provides more documentation for [defining a component](docs/guide/components.md) and
describing [the template language](docs/guide/templates.md).

## Check it

```bash
npm run check                 # typecheck + templates + lint + tool tests + vendor + package + verify + docs + browser tests
APP=example npm test          # the library, the collection and that application's suite
npm run benchmark:ci          # the performance gate, against the checked-in baseline
```

What each command refuses, and what to run after changing what, is in
[getting started](docs/getting-started.md).

## Documentation

The README is the interface. The manual is `docs/`, and the reasoning is `docs/adr/`.

| Where | What is in it |
|---|---|
| [Getting started](docs/getting-started.md) | Run, check, test, and what to run after changing X |
| [Architecture map](docs/architecture.md) | Glossary, the dependency rule, the seams and what proves each |
| [Invariants](docs/invariants.md) | What a change may not break, and the check that enforces it |
| [Guide](docs/guide/) | Startup, components, templates, routing, i18n, preferences, auth, the collection, performance, delivery, testing |
| [Reference](docs/reference/) | The generated project index, the source layout, the Angular map |
| [Decision records](docs/adr/) | One decision per file, cited from source by number |
| [Changelog](CHANGELOG.md) | What changed in the published interface, and what a bump means |

Every generated table is built from `cli/project-model/`, the one AST pass over the
source that the template checker, the dependency verifier and the template bundler also
read:

```bash
npm run docs:check      # a generated table drifted from the source
npm run docs:write      # regenerate it
npm run docs:adr        # a malformed record, or a citation resolving to nothing
```

Where each kind of knowledge belongs is [the documentation
policy](docs/documentation.md), which is itself enforced.

## License

MIT, in [LICENSE](LICENSE).

Three runtime dependencies are vendored into `source/lib/vendor` and redistributed with
this repository: **lit** 3.3.3 (BSD-3-Clause), **@preact/signals-core** 1.14.4 (MIT) and,
for development only, **@tailwindcss/browser** 4.3.3 (MIT). Their notices are in
[source/lib/vendor/LICENSES.md](source/lib/vendor/LICENSES.md), where `npm run vendor`
checks them against the `LICENSE` of the pinned version in `node_modules`, and where each
file came from is in
[source/lib/vendor/provenance.json](source/lib/vendor/provenance.json). A production
artifact carries its own generated `THIRD_PARTY_LICENSES.md` instead; both are described
in [delivery](docs/guide/delivery.md#third-party-notices).

## Credits

I've been presented the idea of a buildless SDK/framework for faster prototyping and development some time ago by coworkers; this is my shot at it, given my familiarity with Angular's ecosystem.