# @srljs/core

**srl** (**s**ource **r**uns **l**ive) is an Angular inspired SDK for lightweight, buildless,
reactive SPAs. Signals, a template dialect that is statically checked without a compiler,
routing, forms, i18n, auth and micro-frontends — plus a component collection built on them.

Development stays usable without a persistent compiler. Production optimisation and static
verification remain optional, deterministic steps.

Full documentation, the guides and the decision records are in
[the repository](https://github.com/BernardoGiordano/srl).

## Two ways to install it, and they are not the same shape

### A browser with an import map — what this library is for

Nothing is bundled and nothing is compiled. Serve the package's two directories on your
origin and paste the import map fragment it publishes.

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

The fragment carries the integrity hashes of the vendored runtime dependencies, computed
from the bytes in `lib/vendor`, so a page gets the library's own map rather than a copy
somebody typed. Source then imports the way the library itself does:

```js
import { defineComponent } from '@core/elements/component.js';
import { SignalElement } from '@core/elements/signal-element.js';
import { UiTable } from '@components/data/ui-table.js';
```

### Node or a bundler

No import map exists, so the bare prefixes above resolve to nothing. Two pre-resolved
bundles are published for that case:

```js
import { defineComponent, SignalElement } from '@srljs/core';
import { UiTable } from '@srljs/core/components';
```

`@srljs/core/components` imports `@srljs/core` rather than inlining it, so one page holds one
custom element registry. Minified builds are `@srljs/core/dist/srl-core.min.js` and
`@srljs/core/dist/srl-components.min.js`; each imports the minified other.

Component templates are inlined into the components bundle, so a bundled application makes
no template request. The buildless path fetches each `.html` beside its module instead,
and both run the same compiler over the same bytes.

Types are not published with the bundles in this version: the sources are annotated in
JSDoc against the `@core/` prefixes, which a consumer's TypeScript cannot resolve either.

## A component, end to end

```js
import { defineComponent } from '@core/elements/component.js';
import { SignalElement } from '@core/elements/signal-element.js';

export class UsersPage extends SignalElement {
  get rows() { return inject(USER_SERVICE).users; }
  reload() { void inject(USER_SERVICE).reload(); }
}

await defineComponent({
  tag: 'users-page',
  element: UsersPage,
  module: import.meta.url,   // the template is this module's sibling .html
  uses: [UiCard],            // the elements this template names, as classes
});
```

```html
<h1>{{ t('users.title') }}</h1>
<button (click)="reload()">{{ t('users.reload') }}</button>

<ui-card *for="user of rows; key: user.id">{{ user.name }}</ui-card>
```

## Runtime dependencies

Two, declared as dependencies and also committed into `lib/vendor` so the buildless path
needs no install: **lit** 3.3.3 (BSD-3-Clause) and **@preact/signals-core** 1.14.4 (MIT).
`lib/vendor` additionally carries **@tailwindcss/browser** 4.3.3 (MIT) for development
pages that compile utilities in the browser; nothing imports it. Notices are in
`lib/vendor/LICENSES.md` and provenance in `lib/vendor/provenance.json`.

## License

MIT. See [LICENSE](LICENSE).
