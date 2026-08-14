# Defining a component

One declaration per component, and the only place its tag is written:

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

- **The template is derived** from `module`: the sibling `.html`. A component that
  builds its markup in `render()` declares `template: false`; one whose markup is
  elsewhere names it with `template`. Renaming a module renames its template with it,
  which a written-down URL could not.
- **`uses` is the dependency, as a value.** A `.html` file cannot import, so
  `<ui-card>` in this markup means `ui-card.js` must have evaluated. Naming the class
  is a real ESM import, so module evaluation order guarantees it — a module body runs
  after every module it imports, top-level `await` included. It is Angular's `imports`
  array, and the template checker reads the same list: a tag the component does not
  import is a build error naming the class to add.
- **Nothing else names the tag.** `component: UsersPage` in a route,
  `tag: UsersPage` as an `<x-outlet>` target, `load: () => import('…').then((m) =>
  m.UsersPage)` for a lazy one, `tagOf(BillingRoot)` for a remote's `rootTag`, and
  startup's `root` reading the class its `load` resolved. `tagOf` is the one place a
  reference becomes a tag, and a class with no definition says so instead of mounting
  nothing.
- **A tag has one owner.** A second class claiming a defined tag is refused, naming
  both classes and the module. Re-declaring the same class with the same tag is a
  no-op, so a module served under two URLs cannot take the page down.
- **The order inside the call is the point.** `uses` is validated, the template is
  compiled, then the element is defined — `customElements.define` upgrades elements
  already in the document and Lit renders on connection, so defining first would flash
  empty markup. A component module ends with this call, which is what makes "the
  module loaded" mean "the element can render".
- **A registered class stays exported even when no JavaScript imports it.** The
  template checker types a template against its element class by name through the
  declaring module, so removing `export` typechecks and lints clean and then fails
  `templates:check`. It is the one class of export whose only consumer is a static
  tool.

`<x-outlet>` and `<x-route-outlet>` are components like any other and must be imported
by the templates that name them. `<x-content>` is not: it is the projection marker the
template dialect defines.

## Two rules that are easy to trip over

**Named content must be a whole element.** Content is projected by *moving* the
authored child nodes into `<x-content>` markers, and which marker a node goes to is
read from its `slot` attribute. A structural directive is the thing that decides
whether an element exists at all, so it cannot carry that decision — everything it
produces goes to the default slot. Targeting a named one means wrapping it:

```html
<ui-sidebar-group>
  <span slot="trigger">…</span>            <!-- must exist to be named -->
  <ui-sidebar-item *for="child of node.children; key: child.key"></ui-sidebar-item>
</ui-sidebar-group>
```

In the default slot a structural directive stands on its own. `*for`, `*if` and
`{{ }}` each compile to a lit binding, which is a *range* between two anchor nodes,
and projection moves those anchors with the output they delimit — so an update lands
where the first render did.

**No structural directive inside an `<svg>`.** `*for`/`*if` compile their body into a
lit template of its own, and lit parses every template as HTML: a `<path>` with no
`<svg>` around it becomes an `HTMLUnknownElement` and draws nothing. Concatenate the
subpaths into one `d` instead — see `example/src/icons.js`.

**A class field silently disables the reactive property it initialises.** The shape
that causes it is the one every Lit example uses:

```js
static properties = { open: { type: Boolean, reflect: true } };
open = false;                       // ← breaks `open` completely
```

`static properties` defines an accessor on the prototype; a class field is installed
with [[Define]], not [[Set]], so it creates an *own* data property that shadows the
accessor. From then on `this.open = true` writes a plain value: no `requestUpdate`, no
re-render, no reflection, and nothing throws. Lit handles the case for properties
present before its constructor runs, but subclass field initialisers run after the
base constructor returns. TypeScript users never see it, because
`useDefineForClassFields: false` compiles fields down to assignments — precisely the
compile step this project does not have. `SignalElement` deletes each shadowing field
and writes it back through the accessor on connect.

**A component's template surface shares a namespace with `HTMLElement`.** `id`,
`title`, `hidden`, `lang` and `children` are taken. tsc reports the collision, so it is
a compile-time annoyance rather than a runtime bug.
