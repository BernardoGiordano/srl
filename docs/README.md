# Documentation

The root [README](../README.md) introduces srl and shows how to run it.
These pages cover the library, its tools, and the decisions behind them.

Both packages ship a copy of these pages under `docs/`, with an `llms.txt`
index at the package root. `npm run package` writes both.

## Start here

| Page | What is in it |
|---|---|
| [Getting started](getting-started.md) | Run the example and choose checks for a change. |
| [Architecture map](architecture.md) | Main modules, dependencies, and boundaries. |
| [Invariants](invariants.md) | Rules that changes must preserve and the checks that enforce them. |
| [Documentation policy](documentation.md) | Where to record guides, reference material, and decisions. |

## Guide

| Page | Subject |
|---|---|
| [Application startup](guide/startup.md) | Startup APIs and hook order. |
| [Defining a component](guide/components.md) | Element definitions, dependencies, styles, and data loading. |
| [The template language](guide/templates.md) | Bindings, directives, DOM security, and static checks. |
| [Editor support](guide/editor-support.md) | VS Code, WebStorm, and generic LSP setup. |
| [Routing](guide/routing.md) | Routes, guards, child layouts, and dynamic mounts. |
| [Internationalisation](guide/i18n.md) | Locales, plurals, RTL, and component text. |
| [Preferences](guide/preferences.md) | Storage adapters and themes. |
| [Auth and remotes](guide/auth-and-remotes.md) | Sessions, token stores, manifests, and grants. |
| [The shared collection](guide/collection.md) | Tables, filters, forms, and other shared components. |
| [Performance](guide/performance.md) | Measurements, budgets, and how to reproduce them. |
| [Delivery](guide/delivery.md) | Development server, production build, and deployment. |
| [Writing a test](guide/testing.md) | Component and browser test patterns. |
| [Supported browsers](guide/browser-support.md) | Recorded browser runs and their limits. |

## Reference

| Page | Subject |
|---|---|
| [Project index](reference/project-index.md) | Generated inventory of elements, globals, and applications. |
| [Template dialect](reference/template-dialect.md) | Generated bindings, directives, expressions, and security contexts. |
| [Diagnostic codes](reference/diagnostic-codes.md) | Generated list of every code `srl check` reports. |
| [Source layout](reference/source-layout.md) | Directory ownership and dependencies. |
| [Angular to this](reference/angular-to-this.md) | Names and patterns familiar to Angular users. |

## Decision records

The [decision records](adr/) explain choices a contributor might otherwise
reverse. Their numbers stay stable so source comments can cite them.
