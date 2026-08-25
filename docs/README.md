# Documentation

`README.md` is the interface: what this is, how to run it, one working component. This
directory is the manual behind it. One subject per page, and the page that owns a subject
owns all of it.

## Start here

| Page | What is in it |
|---|---|
| [Getting started](getting-started.md) | Run, check, test, and what to run after changing X |
| [Architecture map](architecture.md) | Glossary, the dependency rule, the seams and what proves each |
| [Invariants](invariants.md) | What a change may not break, and the check that enforces it |
| [Documentation policy](documentation.md) | Where each kind of knowledge goes, and why |

## Guide

| Page | Subject |
|---|---|
| [Application startup](guide/startup.md) | `startApplication`, `startHostedApplication`, the hook order |
| [Defining a component](guide/components.md) | `defineComponent`, `uses`, the rules that are easy to trip over |
| [The template language](guide/templates.md) | Bindings, directives, DOM security contexts, static checking |
| [Routing](guide/routing.md) | Route configuration, guards, child layouts, dynamic mounting |
| [Internationalisation](guide/i18n.md) | Locales, plurals, RTL, the collection's own text |
| [Preferences](guide/preferences.md) | The persistence boundary, storage adapters, themes |
| [Auth and remotes](guide/auth-and-remotes.md) | Sessions, token stores, manifest admission, remote grants |
| [The shared collection](guide/collection.md) | Tables, filters, forms — the contracts `source/components/` publishes |
| [Performance](guide/performance.md) | The measured envelope, how to read a number, the budgets |
| [Delivery](guide/delivery.md) | The dev server, vendored dependencies, production, deployment traps |
| [Writing a test](guide/testing.md) | The rules the suites already learned |

## Reference

| Page | Subject |
|---|---|
| [Project index](reference/project-index.md) | Every element, global and application — generated from `cli/project-model/` |
| [Source layout](reference/source-layout.md) | Every directory, and what may know about what |
| [Angular to this](reference/angular-to-this.md) | A translation table, not a parity claim |

## Decision records

[`adr/`](adr/) holds one decision per file, each with a number that never changes. Source
comments cite them by number: `ADR-0003`, never a section or a path.
