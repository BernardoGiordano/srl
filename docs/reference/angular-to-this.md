# Angular to this

| Angular | Here |
|---|---|
| `signal` / `computed` / `effect` | same names, `@core/foundation/reactive.js`, `.value` in JS, bare in templates |
| `ChangeDetectionStrategy.OnPush` | automatic; reading a signal in a template subscribes |
| `templateUrl` | derived: the sibling `.html` of the module in `defineComponent` |
| `{{ }}` / `[prop]` / `(event)` | same, plus `[?attr]` and `[.prop]` |
| `*ngIf` / `*ngFor` / `trackBy` | `*if` + `*else` / `*for` / `; key:` |
| `imports: [...]` | `uses: [UiCard]` in the component's definition |
| `inject()` / providers | `@core/foundation/inject.js`, root scope only |
| `DestroyRef` | `this.lifetime`, a DOM `AbortSignal` |
| `resource()` / `rxResource()` | `resource()`, `@core/foundation/resource.js` — reloaded by a call rather than by tracking its loader's reads |
| `ngOnInit` / `ngOnDestroy` | `onMount()` / `onDestroy()` |
| `ng-content` / `<slot>` | `<x-content>`, `@core/elements/projection.js` |
| `NgComponentOutlet` | `<x-outlet>`, driven by a signal |
| `ActivatedRoute.params` | `routeParams`, merged across the matched chain |
| `canActivate` / `loadComponent` | `canActivate` returning `true` or a path / `load` resolving the class |
| `CanDeactivate` | `canDeactivate` on the route, told the element it guards |
| `children` / `<router-outlet>` | `children` / `<x-route-outlet>` |
| `FormControl` / `FormGroup` / `Validators` | `field()` / `group()` / `@core/forms/validators.js`, returning codes |
| `formControlName` + a Material field wrapper | `<ui-field [.field]>` around the control you already wrote |
| `control.disable()` / `form.disable()` | `field.setDisabled(true)` / `group.setDisabled(true)`, and the value stays in `values` ([the collection contracts](../guide/collection.md)) |
| `HttpInterceptor` | `AuthSession.fetch()` / `.json()`, `@auth/session.js` |
| A shared service injected into a remote | `mount(host)`, a frozen capability object |
| `$localize` (build-time, one bundle per locale) | `t()` (runtime, one deployment) |
| `DatePipe` / `CurrencyPipe` | `dt` / `cur`, template globals |
| Module Federation | import map plus `app.manifest.json` |
| Federation `shared` singletons | one URL per dependency in the import map |
