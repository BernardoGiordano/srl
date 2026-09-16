# Defining a component

A component declares its tag, class, template, and element dependencies in one
place.

```js
import { defineComponent } from '@core/elements/component.js';
import { SignalElement } from '@core/elements/signal-element.js';
import { AppCard } from '../ui/app-card.js';

export class UsersPage extends SignalElement {
  rows = [];
}

await defineComponent({
  tag: 'users-page',
  element: UsersPage,
  module: import.meta.url,
  uses: [AppCard],
});
```

`module` finds the sibling `.html` template. A component with a handwritten
`render()` declares `template: false`; another path can be given through
`template`. Export the class so the static checker can type its template.

`uses` lists the element classes named by the template. Their modules run
before this definition, and the template checker reports a missing entry.
Routes and outlets can refer to the class, so the tag remains in its
definition. `defineComponent()` checks dependencies and compiles the template
before registering the element. An existing tag owned by another class is an
error.

Import `<x-outlet>` and `<x-route-outlet>` when a template names them.
`<x-content>` is a projection marker provided by the template dialect.

## Component styles

Declare `styles: true` to load a sibling CSS file.

```js
await defineComponent({
  tag: 'app-card',
  element: AppCard,
  module: import.meta.url,
  styles: true,
});
```

```css
:host { display: block; }
.title { letter-spacing: 0.01em; }
:host([flush]) > .body { padding: 0; }
```

The template compiler marks markup rendered by this component. Its CSS rules
are scoped to that markup, so a caller's projected content and nested
components keep their own styles. `:host` selects the component instance.
The rules use Tailwind's `components` layer, allowing utilities to override
them.

Component CSS is plain CSS. `@import`, Tailwind directives, document-wide
names such as `@keyframes`, and `@layer` are rejected. A styled component
needs a template of its own. Development adopts the scoped file when the tag
is defined and swaps its rules after an edit. A build uses the same rewrite
and adds the result to its stylesheet.

## Projection and reactive properties

Named projected content needs a stable element with a `slot` attribute.
A structural directive creates or removes its element, so wrap it when the
result belongs in a named slot.

```html
<ui-sidebar-group>
  <span slot="trigger">Sections</span>
  <ui-sidebar-item *for="child of node.children; key: child.key"></ui-sidebar-item>
</ui-sidebar-group>
```

Structural directives work in the default slot. Projection moves their
anchor nodes with their rendered content, so later updates land in the same
place. Inside SVG, a compiled `*for` or `*if` body is parsed as HTML.
Build path data outside the directive, as `example/src/icons.js` does.

Lit reactive properties use prototype accessors. A class field of the same
name creates an own property and can shadow that accessor.

```js
static properties = { open: { type: Boolean, reflect: true } };
open = false;
```

`SignalElement` repairs a shadowed reactive property on connect. A field that
hides a method such as `render` is rejected because there is no accessor to
restore. Rename the field or define a method. Template-facing names also
share `HTMLElement`'s namespace, so names such as `title` and `children`
may conflict.

## Reading asynchronous data

Use `resource()` for one latest request tied to an element's lifetime.

```js
import { resource } from '@core/foundation/resource.js';

export class OrdersPage extends SignalElement {
  /** @type {TableQuery} */
  #query = { page: 1, pageSize: 20, sort: { key: '', direction: '' }, filters: [] };

  #page = resource((signal) => inject(SALES_SERVICE).searchOrders(this.#query, signal), {
    initial: { rows: [], total: 0 },
    lifetime: () => this.lifetime,
  });

  rows = computed(() => this.#page.value.value.rows);
  loading = this.#page.pending;
  failed = this.#page.failed;

  onMount() { void this.#page.reload(); }

  /** @param {TableQuery} query */
  load(query) {
    this.#query = query;
    return this.#page.reload();
  }
}
```

`reload()` aborts the previous request and ignores an answer from an older
one. The required `initial` value supports rendering before `onMount()`.
`pending` starts true. Pass `lifetime` as a function so a reattached
element uses its new signal.

A failed reload leaves the last value and sets `failed`. A detail screen can
hide that old value while showing an error. `reload()` resolves with the new
value, or `undefined` after an abort, superseded request, or failure. The
caller can use that result to fill a form or append rows.

`resource()` owns one value and one latest call. An application can build a
shared record store over it. The example's `OrderRecords.watch()` keeps one
resource per order id while readers are mounted, follows route parameter
changes, refreshes after a write, and releases the entry after the final
reader leaves.
