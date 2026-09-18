<h1 align="center">srl</h1>

<p align="center">
  <strong>s</strong>ource <strong>r</strong>uns <strong>l</strong>ive — reactive web components with a buildless development workflow.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@srljs/core"><img alt="@srljs/core on npm" src="https://img.shields.io/npm/v/@srljs/core?label=%40srljs%2Fcore"></a>
  <a href="https://www.npmjs.com/package/@srljs/cli"><img alt="@srljs/cli on npm" src="https://img.shields.io/npm/v/@srljs/cli?label=%40srljs%2Fcli"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="Node.js 22 or later" src="https://img.shields.io/badge/node-%3E%3D22-brightgreen">
</p>

<p align="center">
  <a href="https://srl-example.santella.dev">Live demo</a> ·
  <a href="docs/getting-started.md">Getting started</a> ·
  <a href="docs/guide/">Guides</a> ·
  <a href="docs/architecture.md">Architecture</a>
</p>

---

srl is an Angular-inspired library for single-page applications built with web
components. During development, the browser loads your JavaScript, HTML templates,
and CSS as source files through an import map. You can check templates and types
without compiling the application. A separate build produces minified files for
deployment.

The library includes signals, dependency injection, routing, forms, localization,
authentication, remote applications, and a component collection. The
[live example](https://srl-example.santella.dev) shows them working together.
Its source is in [`example/`](example/).

## Get started

Create a project with Node.js 22 or later.

```bash
npx @srljs/cli@0.9.0 new my-app
cd my-app
npm install
npm run dev
```

`srl new` writes a project whose application boots through the library's
startup, router, manifest, and locale bundle. `npm run check` checks types,
templates, the import map, and messages, and `npx --no-install srl generate
component <tag>` adds a component. The server loads the source files directly
and updates open pages when they change. The [CLI guide](cli/README.md) covers
checks, production builds, and deployment requirements.

You can also run this repository's example without installing packages.

```bash
npm run example  # includes the demo backend at http://localhost:8100
```

The [getting started guide](docs/getting-started.md) covers sign-in and the
repository checks.

## A component

A component declares its element class and points to a sibling HTML template.

```js
import { defineComponent } from '@core/elements/component.js';
import { SignalElement } from '@core/elements/signal-element.js';

export class GreetingCard extends SignalElement {
  name = 'world';
}

await defineComponent({
  tag: 'greeting-card',
  element: GreetingCard,
  module: import.meta.url,
});
```

```html
<h1>Hello, {{ name }}</h1>
```

The template checker checks `name` against the class. The
[component guide](docs/guide/components.md) covers element dependencies, styles,
and data loading. The [template guide](docs/guide/templates.md) lists the binding
syntax.

## How it is delivered

| Package | Purpose |
|---|---|
| [`@srljs/core`](source/README.md) | Browser source modules, components, templates, types, and package exports for bundlers. |
| [`@srljs/cli`](cli/README.md) | Scaffold, development server, static checks, language server, and production build. |

For direct browser loading, serve the library's `lib/` and `components/` folders
on the same origin as your application. The published `lib/importmap.json` maps
`@core/` and `@components/` to those folders. The CLI writes this setup, and the
[example document](example/index.html) shows it in place.

For Node.js or a bundler, use the package exports.

```js
import { defineComponent, SignalElement } from '@srljs/core';
import { UiTable } from '@srljs/core/components';
```

The production build checks templates, compiles CSS, and writes minified,
integrity-pinned assets. The [delivery guide](docs/guide/delivery.md) explains
the artifact and its deployment checks.

## Work in this repository

The library lives in [`source/`](source/), the CLI in [`cli/`](cli/), editor
clients in [`editors/`](editors/), and repository checks in [`tools/`](tools/).
The [source layout](docs/reference/source-layout.md) maps the main modules.

```bash
npm install
npm run check
```

The full check runs type and template checks, lint, tool and browser tests,
package verification, and documentation checks. The [contributing guide](CONTRIBUTING.md)
explains the smaller checks to run while editing.

The [guides](docs/guide/) explain how to build an application. The
[architecture map](docs/architecture.md) describes the module boundaries, and
the [decision records](docs/adr/) explain selected design choices.

## License and credits

srl is MIT licensed. See [LICENSE](LICENSE) and the
[third-party notices](source/lib/vendor/LICENSES.md).

The idea grew from conversations with coworkers about faster prototyping
without a development build. AI coding assistants helped design, implement,
and test this SDK.
