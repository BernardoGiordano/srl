# srl

**srl** (**s**ource **r**uns **l**ive) is an Angular inspired SDK to create lightweight, buildless and reactive SPAs.

Development stays usable without a persistent compiler, while production optimisation and static verification remain optional, deterministic steps.

Everything expensive is opt-in and behaviour-preserving: the CSS generation step, the template bundle, a comment strip. Nothing is required to run the application.

**Note**: this SDK has been designed, built and tested with some help from AI coding assistants. This repository is structured to serve as insightful documentation for both humans and AI coding assistants, to speed up the generation and the prototyping of new software.

## Repository structure

```
source/lib/         the framework: core, auth, host, vendored deps, its own suite
source/components/  the shared collection: the frame of an internal application
example/            the example application: four sections, auth over a real backend,
                    micro-frontends, i18n
tools/              discovery, static checks, delivery, dev server, benchmarks
```

## Run it

```bash
npm run example                                 # the application, http://localhost:8100
node tools/dev/serve.mjs --open                 # any application, statically, http://localhost:8000
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
npm run check                 # typecheck + templates + lint + tool tests + vendor + verify + docs + browser tests
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
| [Known gaps](docs/known-gaps.md) | Open questions and the rule for deciding each |
| [Guide](docs/guide/) | Startup, components, templates, routing, i18n, preferences, auth, the collection, performance, delivery, testing |
| [Reference](docs/reference/) | The generated project index, the source layout, the Angular map |
| [Decision records](docs/adr/) | One decision per file, cited from source by number |

Every generated table is built from `tools/project-model/`, the one AST pass over the
source that the template checker, the dependency verifier and the template bundler also
read:

```bash
npm run docs:check      # a generated table drifted from the source
npm run docs:write      # regenerate it
npm run docs:adr        # a malformed record, or a citation resolving to nothing
```

Where each kind of knowledge belongs is [the documentation
policy](docs/documentation.md), which is itself enforced.

## Credits

I've been presented the idea of a buildless SDK/framework for faster prototyping and development some time ago by coworkers; this is my shot at it, given my familiarity with Angular's ecosystem.