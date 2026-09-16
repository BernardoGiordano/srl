# @srljs/core

**srl** (**s**ource **r**uns **l**ive) is an Angular-inspired SDK for lightweight,
buildless, reactive single-page applications. It gives you signals, a template dialect
that is statically checked without a compiler, routing, forms, i18n, auth and
micro-frontends, plus a component collection built on all of it.

The browser loads your source files directly. Production optimisation and static
verification are separate, optional, deterministic steps.

Full documentation, the guides and the decision records are in
[the repository](https://github.com/BernardoGiordano/srl).

## Two ways to install

The two shapes are not the same. The first is what this library is for.

### A browser with an import map

Nothing is bundled and nothing is compiled. Serve the package's two directories from your
origin and paste the import-map fragment it publishes.

```
node_modules/@srljs/core/lib/          ->  /lib/
node_modules/@srljs/core/components/   ->  /components/
```

```html
<script type="importmap">
  <!-- the contents of node_modules/@srljs/core/lib/importmap.json -->
</script>
<script type="module" src="/src/main.js"></script>
```

The fragment carries integrity hashes for the vendored runtime dependencies, computed from
the bytes in `lib/vendor`, so a page gets the library's own map rather than a copy somebody
typed. Your source then imports the way the library itself does.

```js
import { defineComponent } from '@core/elements/component.js';
import { SignalElement } from '@core/elements/signal-element.js';
import { UiTable } from '@components/data/ui-table.js';
```

### Node or a bundler

No import map exists there, so the bare prefixes above resolve to nothing. Two
pre-resolved bundles cover that case.

```js
import { defineComponent, SignalElement } from '@srljs/core';
import { UiTable } from '@srljs/core/components';
```

`@srljs/core/components` imports `@srljs/core` rather than inlining it, so one page holds
one custom element registry. Minified builds are `@srljs/core/dist/srl-core.min.js` and
`@srljs/core/dist/srl-components.min.js`, and each imports the minified other.

Component templates are inlined into the components bundle, so a bundled application makes
no template request. The buildless path fetches each `.html` beside its module instead.
Both run the same compiler over the same bytes.

## Types

Both paths are typed from one set of JSDoc, written in the `.js` files the browser runs.

The bundles carry their own declarations, so `import { defineComponent } from '@srljs/core'`
is typed with no configuration. `exports` names a `.d.ts` beside each bundle.

The buildless path needs the table that resolves `@core/…` for tsc, which this package
publishes.

```json
{
  "extends": "@srljs/core/tsconfig.base.json",
  "include": ["web/**/*.js"]
}
```

Extend it from the root of your repository and `@core/…` resolves for tsc to the
declarations of the modules the browser loads, from one table rather than a copy.

## A component, end to end

```js
import { defineComponent } from '@core/elements/component.js';
import { SignalElement } from '@core/elements/signal-element.js';
import { UiAvatar } from '@components/shell/ui-avatar.js';

export class UsersPage extends SignalElement {
  get rows() { return inject(USER_SERVICE).users; }
  reload() { void inject(USER_SERVICE).reload(); }
}

await defineComponent({
  tag: 'users-page',
  element: UsersPage,
  module: import.meta.url,   // the template is this module's sibling .html
  uses: [UiAvatar],          // the elements this template names, as classes
});
```

```html
<h1>{{ t('users.title') }}</h1>
<button (click)="reload()">{{ t('users.reload') }}</button>

<ui-avatar *for="user of rows; key: user.id" [name]="user.name"></ui-avatar>
```

## Building and deploying

`@srljs/cli` is the toolchain — the scaffold, the dev server, the template checker, the
language server and the release pipeline. It is a separate package, and nothing in it is
needed to run an application.

```bash
npm install --save-dev @srljs/cli
```

## Runtime dependencies

Two, declared as dependencies and also committed into `lib/vendor` so the buildless path
needs no install. They are **lit** 3.3.3 (BSD-3-Clause) and **@preact/signals-core** 1.14.4
(MIT). `lib/vendor` additionally carries **@tailwindcss/browser** 4.3.3 (MIT) for
development pages that compile utilities in the browser, and nothing imports it. Notices
are in `lib/vendor/LICENSES.md`, provenance in `lib/vendor/provenance.json`.

## License

MIT. See [LICENSE](LICENSE).
