# @srljs/core

**srl** (**s**ource **r**uns **l**ive) is an Angular-inspired library for reactive
web components. It includes signals, templates, routing, forms, localization,
authentication, remote applications, and a component collection.

The browser can load the library and your application as source files through
an import map. Types and templates can be checked without compiling the app.
A separate production build is available through [`@srljs/cli`](https://www.npmjs.com/package/@srljs/cli).

## Install

```bash
npm install @srljs/core
```

### Direct browser loading

Serve these package directories from the same origin as your application.

```text
node_modules/@srljs/core/lib/          -> /lib/
node_modules/@srljs/core/components/   -> /components/
```

Copy the JSON from `node_modules/@srljs/core/lib/importmap.json` into an
`<script type="importmap">` element. It maps the browser specifiers and pins
the vendored runtime files with integrity hashes. The CLI scaffold writes
this setup for you. The [example document](https://github.com/BernardoGiordano/srl/blob/main/example/index.html)
shows a complete import map.

Your source can then import individual modules.

```js
import { defineComponent } from '@core/elements/component.js';
import { SignalElement } from '@core/elements/signal-element.js';
import { UiTable } from '@components/data/ui-table.js';
```

### Node.js or a bundler

Use the package exports when an import map is unavailable.

```js
import { defineComponent, SignalElement } from '@srljs/core';
import { UiTable } from '@srljs/core/components';
```

The component bundle imports the core bundle, so both use the same element
registry. The bundles include component templates. Direct browser loading
fetches each template beside its component module.

## A component

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

The sibling `greeting-card.html` contains its template.

```html
<h1>Hello, {{ name }}</h1>
```

The template checker checks bindings against the class. The
[component guide](https://github.com/BernardoGiordano/srl/blob/main/docs/guide/components.md)
explains dependencies, styles, and data loading.

## Types

The source modules carry JSDoc types, and the package ships declarations
generated from them. Package exports resolve to their declarations without
extra configuration. For direct browser imports, extend the published base
configuration from your repository root.

```json
{
  "extends": "@srljs/core/tsconfig.base.json",
  "include": ["web/**/*.js"]
}
```

The base configuration resolves `@core/` and `@components/` for the type
checker. The CLI scaffold writes this file too.

## Tools and documentation

Install `@srljs/cli` as a development dependency to scaffold an application,
serve source with live updates, check templates, or build a production artifact.
The [repository](https://github.com/BernardoGiordano/srl) contains the guides,
architecture map, and working example.

## Runtime dependencies and license

The runtime uses Lit 3.3.3 and `@preact/signals-core` 1.14.4. Their browser
files are also committed under `lib/vendor/`. That directory includes
`@tailwindcss/browser` 4.3.3 for development pages that use it. The package
records licenses in `lib/vendor/LICENSES.md` and file provenance in
`lib/vendor/provenance.json`.

The package is MIT licensed. See [LICENSE](LICENSE).
