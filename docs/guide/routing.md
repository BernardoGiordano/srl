# Routing and dynamic mounting

Attach a route table to the element that owns the outlet.

```js
onMount() {
  void attachRouter(this, createRoutes());
}
```

Paths may contain literal segments, `:param`, a `/*` prefix, or `*` as a
catch-all. When only a parameter changes, the router reuses the mounted
component and updates `routeParams`.

Routes follow these rules.

- The host may render its outlet after `onMount()`. The router waits for it and
  reports the missing selector if no outlet appears.
- The first match wins in flattened declaration order. A parent with children
  needs an index child to match its own path.
- `attachRouter()`, `navigate()`, and `navigationSettled` resolve after guards,
  lazy modules, and mounting settle.
- `navigationError` holds a failed navigation and clears after a success.
  Link clicks and history changes have no caller to reject. Entry navigation
  can reject `attachRouter()`.
- A failed navigation restores the previous URL and view when the old view is
  still mounted. The router builds entering levels before releasing the old
  chain and unmounts any new level that loses the attempt.
- `stop()` removes listeners and releases the chain from child to parent.
  Attaching a new router stops the previous attachment.
- `AppRouter` and the matcher stay internal. Applications use
  `attachRouter()` and `navigate()`.

## Child layout routes

A parent route can supply a path prefix, guard, and layout that remains mounted
while its children change.

```js
{
  path: '/settings',
  load: () => import('./settings-layout.js').then((m) => m.SettingsLayout),
  canActivate: requireSession,
  children: [
    { path: '', redirect: '/settings/users' },
    { path: 'users', load: () => import('./settings-users.js').then((m) => m.SettingsUsers) },
    { path: 'roles/:id', load: () => import('./settings-role.js').then((m) => m.SettingsRole) },
  ],
}
```

The layout marks the child outlet in its template.

```html
<h1>{{ t('settings.title') }}</h1>
<x-route-outlet></x-route-outlet>
```

- Changing children keeps the parent instance, its state, and its scroll
  position. Leaving the section unmounts children first.
- `canActivate` runs from parent to child on every navigation, before loading
  the child module.
- `canDeactivate` runs from child to parent for levels that will leave. It
  receives the element it guards. Returning `false` keeps the current view and
  URL.
- Parameters from matched levels merge into one `routeParams` signal. A deeper
  level wins when names repeat.
- A parent without a component can still contribute a prefix and guard.
- The router flattens and validates the tree when attaching. Invalid
  configurations fail before a user visits their paths.

`<x-route-outlet>` uses `display: contents` by default so it does not add a
layout box. Give it a class when the outlet itself should grow or take padding.

## Mounting a view

Routes, remotes, startup, and `<x-outlet>` use the mounting code in
`@core/elements/mount.js`.

```js
import { MountSequence, createElement } from '@core/elements/mount.js';

const sequence = new MountSequence();
const attempt = sequence.begin();
const request = {
  where: '<x-outlet>',
  load: () => import('./chart-panel.js').then((m) => m.ChartPanel),
};
const element = await createElement(request);
if (await attempt.place(container, element, request)) { /* it landed */ }
```

A request can name a component class, definition, or tag. `load` may resolve
one on demand, and a later visit reuses the registered definition. The mounting
code validates what a custom `create` function returns. Only the newest attempt
can place its element; older attempts release anything they acquired.
`MountError` names the caller through `where`. Properties in `props` are
assigned as properties, so object values survive.

The remote layer revokes its `HostContext` on departure. That security lifetime
belongs to the remote contract rather than the generic mounting code.
