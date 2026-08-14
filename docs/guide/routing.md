# Routing and dynamic mounting

`attachRouter(host, routes)` takes the shell and a route table, and that is the whole
of what an application writes:

```js
onMount() {
  void attachRouter(this, createRoutes());   // { outlet: '#views' } to override <main>
}
```

Paths support one literal, `:param`, a `/*` prefix and `*` as a catch-all. Navigating
`/users/1` to `/users/2` re-renders the mounted component rather than replacing it,
because the route did not change — only `routeParams` did.

The rules of the seam:

- **The host is the element, not the outlet.** The outlet may not exist when `onMount`
  runs — a `<main>` inside a component that projects content arrives at the end of
  *that* component's render — so waiting for it belongs in the router rather than in
  every shell. A host that renders no outlet is an error naming the selector.
- **First match wins**, in flattened declaration order. A URL matching nothing renders
  nothing unless a catch-all is declared. A parent with children and no index child is
  never matched on its own.
- **Completion is a promise.** `attachRouter`, `navigate` and `navigationSettled`
  resolve when the navigation has settled: guards resolved, lazy modules fetched, view
  mounted. Nothing needs a timer to know a route arrived.
- **Failure is state.** `navigationError` holds why the latest navigation failed and is
  cleared when one succeeds. Most navigations have no caller — a link click, the back
  button — so `navigate` does not reject. The entry navigation is the exception: it is
  part of attaching, so it rejects `attachRouter`, because startup has one owner to
  report to.
- **A navigation settles as one transaction.** The URL, `routeParams`, `queryParams`,
  `currentPath` and the mounted chain describe one screen, so a navigation that does not
  arrive puts all of them back: a broken route leaves the previous view mounted *and*
  the previous URL published, rather than announcing a destination nobody can see. Every
  entering level is built before anything is torn down, so a lazy import that rejects, a
  module that defines no element and a `mount()` that throws all fail while the
  navigation is still reversible — and a level built for a chain that then failed is
  still paired with its `unmount`. The URL goes back by `replaceState`, so a failed
  navigation that pushed leaves one extra history entry holding the URL that is on
  screen; going back can never land on a route that failed. Two failures can only
  happen after the outgoing chain is released — a layout that renders no
  `<x-route-outlet>`, which cannot be discovered until that layout is on screen, and an
  `unmount` hook that throws — and there the state describes the destination, because
  the screen it would go back to no longer exists.
- **Teardown has one owner.** `stop()` releases the chain deepest-first, drops the
  listeners, and stops being the attachment `navigate()` reaches. Attaching again stops
  the previous attachment first, because two routers on one document would both answer
  the same link click.
- **How a URL is matched is private.** `attachRouter` and `navigate` are the only seam,
  which is what leaves the matcher free to gain an index if a route table ever grows
  enough to need one. `AppRouter` is not exported.

## Child layout routes

`children` is Angular's child-route tree. A parent contributes its path prefix, its
guard and, when it names a component, a layout that stays mounted while its children
come and go:

```js
{
  path: '/settings',
  load: () => import('@app/pages/settings-layout.js').then((m) => m.SettingsLayout),
  canActivate: requireSession,
  children: [
    { path: '', redirect: '/settings/users' },
    { path: 'users', load: () => import('@app/pages/settings-users.js').then((m) => m.SettingsUsers) },
    { path: 'roles/:id', load: () => import('@app/pages/settings-role.js').then((m) => m.SettingsRole) },
  ],
}
```

The layout's template marks the slot its children render into, which is Angular's
`<router-outlet>`:

```html
<h1>{{ t('settings.title') }}</h1>
<x-route-outlet></x-route-outlet>
```

- **The layout survives its children.** Moving between siblings replaces only the
  child; the layout instance, its scroll position and its state are untouched. Leaving
  the section tears the chain down deepest first.
- **Guards run parent to child on every navigation**, so a section's guard answers
  before any child's lazy module is fetched, and a revoked permission is caught while
  the user is inside the section rather than only on entry.
- **`canDeactivate` runs child to parent, before any of that.** It is asked only of the
  levels genuinely being released — a surviving layout and a parameter change ask nobody
  — and is told the element it is guarding, which is how it reaches the screen's own
  state. Answering `false` keeps the user where they are and puts the URL back to what is
  on screen; unlike `canActivate`, it needs no redirect target, because refusing to leave
  already names the destination. A refused *back button* leaves the history stack
  slightly wrong, which is the accepted cost of not racing a `history.go(1)` against the
  popstate it triggers. See [the collection contracts](collection.md)'s forms notes and `example/src/routes.js`.
- **Parameters merge across levels**, deepest wins a name clash. `routeParams` stays
  one flat signal.
- **A parent may have no component at all.** It then contributes a prefix and a guard
  and nothing else — Angular's componentless route — and its children render in its own
  parent's outlet.
- **The tree is flattened once, when the router attaches.** One matcher per leaf, so
  `children` costs nothing per navigation. Configuration that could never match —
  children behind a wildcard, a parent with both `children` and `redirect` — rejects
  `attachRouter` rather than failing at a URL nobody tried yet.
- **`<x-route-outlet>` is `display: contents`**, for the reason `<x-content>` is: an
  inline wrapper between a flex or grid container and the page would break every layout
  utility on it. Put a class on the outlet to make it a real box — the default is
  declared in a cascade layer below Tailwind's, so any utility beats it. (Specificity
  alone would not: layers are compared before specificity, and an unlayered
  `x-route-outlet { display: contents }` quietly defeats `class="block p-4"`.)

## Mounting a view

Three things put a custom element on screen on demand: `<x-outlet>` when a signal
changes, the router when a route matches, and `core/remotes/mfe.js` when a navigation
enters a remote's mount path. All three are adapters over `@core/elements/mount.js`,
as is the `root` step of startup, which checks a definition without instantiating it:

```js
import { MountSequence, createElement } from '@core/elements/mount.js';

const sequence = new MountSequence();       // one per caller
const attempt = sequence.begin();           // one per swap; supersedes the last

const request = { where: '<x-outlet>', load: () => import('...').then((m) => m.ChartPanel) };
const element = await createElement(request);
if (await attempt.place(container, element, request)) { /* it landed */ }
```

- A request names its component as a class, a definition or a tag, and `load` may
  resolve one instead — which is how a caller learns what it is mounting from the module
  it just loaded, and why no route table repeats a tag string.
- `load` runs only while the tag it names is undefined, so a second visit to a lazily
  loaded view costs no fetch.
- A tag still undefined after its `load` resolved is an error naming the tag, not an
  indefinite wait.
- `create` — a route's `mount()`, a remote's `mount(host)` — has its result validated
  against the tag the request names, because that is where code this library did not
  write crosses into it.
- Only the newest attempt of a sequence may complete. An older one releases the element
  it had already built, which is what pairs a `mount()` that acquired resources with its
  `unmount` when it lost a race and never reached the DOM.
- Every failure is a `MountError` carrying `where`, so the caller is named in the
  message rather than inferred from a stack.
- `props` are assigned as properties, never attributes, so an object survives.
  Capability lifetime stays out: `core/remotes/mfe.js` revokes a remote's `HostContext`
  itself, because a security boundary is not a mounting concern.
