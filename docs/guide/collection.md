# Shared collection contracts

`source/components` is the frame of an internal business application: the collapsible
sidebar, the header, the accordion menu, the breadcrumb, the dropdown, the table, the
filter and the inputs it needs. Reached through the `@components/` prefix:

```js
import '@components/shell/ui-sidebar.js';
```

Every element owns behaviour, semantics and state, and leaves layout to the consumer.
State is published as `data-*` attributes so a stylesheet can see it:

```html
<ui-sidebar class="group/sidebar w-60 transition-[width] data-collapsed:w-[76px]">
  <span class="group-data-collapsed/sidebar:hidden">Settings</span>
</ui-sidebar>
```

That is the whole collapse animation: no JavaScript in the application and no class list
computed anywhere. Where an element renders a semantic element of its own — the `<a>` in
`ui-sidebar-item`, the `<button>` in `ui-sidebar-toggle` — its classes come from a
`*-class` property, because the alternatives were `role="button"` plus keydown handling
(a worse button) or child selectors like `[&>a]:flex` at every call site. Internals the
library stylesheet addresses carry stable `data-ui-part` attributes such as `menu-panel`
and `avatar-fallback`; they are styling hooks, not state.

| Element | What it owns | What it leaves to you |
|---|---|---|
| `ui-app-shell` | mobile drawer state, backdrop, close on Escape and on navigation, `data-drawer-open` | every box and every class |
| `ui-sidebar` | collapsed state, persistence, `data-collapsed` | width, colour, contents |
| `ui-sidebar-toggle` | finds the sidebar or the shell's drawer with `closest()`, keeps `aria-expanded` true | the button's classes and icon |
| `ui-sidebar-item` | is this row the current route, `data-active`, `aria-current` | the row's content and classes |
| `ui-sidebar-group` | open/closed, auto-open on a matching route, `data-open`, `aria-controls` | trigger content, panel classes |
| `ui-topbar` | `role="banner"`, `data-stuck` past a scroll offset | everything visual |
| `ui-breadcrumb` | trail from data, last step not a link, `aria-current` | classes for list, item, link, separator |
| `ui-avatar` | initials from a name, fallback when the image 404s | shape, size, colours |
| `ui-menu` | open/closed, close on outside pointer, Escape with focus return, navigation | trigger, panel, positioning |
| `ui-dialog` | a native `<dialog>` shown modally: top layer, inert page, focus trap and return, blurred backdrop, document scroll lock; Escape and a backdrop click *ask* rather than close, and `mandatory` refuses even to ask | every word in the panel, and the panel's own box through `panel-class` |
| `ui-table` + `ui-table-column` | native table semantics; client/server/infinite pagination; sort, filters, column chooser, reorder, resize, sticky edges, persistence; its own accessible names | data fetching, column declarations, rich-cell renderers, the words behind `ui.table.*` |
| `ui-combobox` | searchable multi-select: chips, grouped panel in the top layer, keyboard and ARIA, free-text tags, per-row expansions, scroll kept across option changes; the form-control contract, so a form binds it as codes | where options come from, label and placeholder, option and chip content |
| `ui-field` | one field: the label, the error, the three ARIA attributes that tie them together, the value wiring in both directions, and the disabled state pushed onto the control plus `data-disabled` on itself | the control element itself, its classes, and the words behind `ui.field.*` |
| `ui-dynamic-filter` | nine rule types compiled into options, one value per ref, persistence, lazy and typeahead loading, the active-filter rail | rule declarations, group and option text, what the emitted state filters |
| `ui-date-range` | two day fields and a confirm, plus the inclusive/exclusive conversion | the words behind `ui.dateRange.*`, and where to render it |
| `internal/open-panel.js` | everything an open panel owes: the top layer and the placement (under the anchor, flipped when the room is above, clamped and re-measured), dismissal on an outside pointer and on Escape with focus return, `aria-expanded`/`aria-controls`, and the release | which element triggers what, and whether to decline the placement |
| `internal/dom.js` | `optionalAttr` (an empty string removes the attribute), `isRtl`/`directionSign`, `nextElementId` | when to reach for any of them |
| `internal/text.js` | the standard interaction text, one key per string | every word behind those keys |
| `data/filter-descriptor.js` | what "filtered" means: `ANY_COLUMN`, the `contains`/`equals`/`range` modes, the match each rule type implies, and the row comparison | which element produces filters and which applies them |

## Tables

Columns stay at the use site; data stays application-owned:

```html
<ui-table
  pagination="server"
  [.rows]="rows"
  [.total-rows]="total"
  [.filters]="filters"
  (query-change)="loadQuery($event)"
>
  <ui-table-column key="supplier.name" label="Supplier" sortable></ui-table-column>
  <ui-table-column key="value" label="Value" [.renderer]="renderValue"></ui-table-column>
</ui-table>
```

`pagination="client"` filters, sorts and slices supplied rows. `none` filters and sorts
without slicing. `server` and `infinite` leave row processing to the consumer. A sortable
header cycles ascending → descending → clear; `sort-start="desc"` reverses its first
step.

Every page, page-size, sort or external filter change emits one bubbling `query-change`:

```js
{ page: 1, pageSize: 20, offset: 0, mode: 'server', sort: { key: 'supplier.name', direction: 'asc' }, filters: [...] }
```

`page-change`, `sort-change` and `filter-change` emit the same detail for consumers
needing scoped signals. Filter and sort changes reset the page to one. `infinite` emits
`load-more` from its intersection sentinel or its accessible button. Pages are one-based,
offsets zero-based. Optional `renderer(row, index, value)` may return text, a DOM node or
a Lit template result.

Column customisation is opt-in and declarative: `hideable` offers a column in the
visibility chooser, which also exposes logical start/end pinning and reorder controls;
`locked` removes all user configuration for one column; header drag handles and
Left/Right keys reorder; resize handles accept pointer drag and Left/Right keys;
`sticky="start|end"` uses logical CSS insets, so the same declaration works in LTR and
RTL. Widths are pixel numbers; sticky offsets use configured, resized or measured widths.

`state-id` opts the table into the persistence of [preference persistence](preferences.md) (`table-name` is a compatibility
alias; `state-id` wins). The versioned payload holds page, page size, sort, order, hidden
columns, widths and sticky positions — never rows, renderers or predicates. Add
`persist-filters` only when the descriptors are JSON-safe. `table.state`, `saveState()`
and `resetState()` are the imperative API: `saveState()` writes immediately, while the
changes the element notices itself are debounced and flushed on disconnect, so holding an
arrow key on a resize handle is one write rather than one per keypress. `state-change`,
`state-restore` and `column-change` expose the same lifecycle as bubbling DOM events; a
server table issues its initial fetch from `state-restore`'s `event.detail.query`.

Internally, one private presentation projection holds the ordered, visible and
configurable column lists, the sticky-offset map and two lazy style caches, rebuilt only
when a presentation input changes. Column revision is tracked separately from
presentation revision because it keys the processed-row cache: a resize drag must not
re-filter and re-sort 10,000 rows per pointer move.

## Filters

`ui-dynamic-filter` is one control holding every filter a screen offers, plus the rail of
chips saying which are on. A screen declares rules and consumes state; it does not touch
options:

```js
filter.rules = [
  { ref: ANY_COLUMN, type: 'free' },
  { ref: 'team', type: 'children', group: t('team'), children: teams },
  { ref: 'city', type: 'lazy', group: t('city'), label: t('loadCities'),
    children: () => api.cities() },
  { ref: 'comune', type: 'typeahead', group: t('comune'), label: t('search'),
    children: (term, { signal }) => api.searchComuni(term, signal),
    resolve: (values) => api.comuniByIds(values) },
];
```

| type | options come from | loaded |
|---|---|---|
| `boolean`, `option`, `date` | the rule, one option | at once |
| `children` | an array on the rule | at once |
| `free` | whatever is typed, as a tag | never |
| `observer` | a promise | on connect |
| `lazy` | a promise | when its row is clicked |
| `typeahead` | a promise per term | while typing, debounced |
| `daterange` | presets plus a custom range | at once |

`lazy` and `typeahead` both exist because "load everything" stops working at some size:
`lazy` defers a list that is large but bounded, `typeahead` never loads a list at all,
which is the only workable answer for an 8,600-entry domain. Each ref holds one value and
its siblings grey out rather than disappear; `multiple: true` allows several.

The emitted state is a filter descriptor, so the filter and the table connect with one
assignment and never import each other — both import `filter-descriptor.js`:

```js
onFilters(event) { this.filters.value = event.detail; }
```

```js
table.filters = [
  { key: ANY_COLUMN, value: 'milan' },
  { key: 'status', value: 'active', match: 'equals' },
  { key: 'createdAt', value: range, match: 'range' },
  { value: something, predicate: (row, value) => inside(row.createdAt, value) },
];
```

`ANY_COLUMN` searches all declared columns; a column-specific filter reads its dotted
`key`. `match` is `contains` (case-insensitive, the default), `equals`, or `range` — a
half-open `since to until` string, the format `ui-date-range` stores. A
`predicate(row, value, index)` overrides `match` entirely, and table-level
`filterPredicate(row, filters, index)` takes over when filter state has another shape.
`ui-table-column.sortValue` and `.filterValue` provide orthogonal values for rendered
cells.

`match` comes from the rule type, not from the screen: every listed choice means
`equals` — with `contains`, choosing *Sales* would also select *Pre-Sales* — `free` means
`contains`, and `daterange` means `range`. `condition` on a rule is optional; omitted, it
means "match the column named `ref`, the way this rule type matches".

What is chosen is persisted per `name`, and an entry whose option no longer exists is
dropped on load rather than lingering as a filter nobody can see. A deferred rule with
something in storage is not deferred: `lazy` fetches its list on load when a persisted
value belongs to it, and `typeahead` resolves its labels through `resolve`, or by
searching for each persisted value and keeping the result that *is* it. Skipping either
does not merely delay a chip — the option does not exist, so the entry is dropped and the
filter the user left switched on disappears.

Ranges store a **half-open interval**: the stored `until` is exclusive, because the query
behind it is `since <= x < until`. Every field and every label works in inclusive days,
and the conversion happens in one place, `ui-date-range`. A preset marked `default: true`
is selected when nothing is stored and is deliberately not written back, so a default of
"this week" means this week on every visit. The custom-range row opens its editor inline,
under itself, rather than in a modal — a modal darkens the page and takes focus to ask a
question the user asked for by clicking one row.

One interaction worth knowing: `ui-table` returns to page one whenever `.filters` changes
identity. That is right for a filter change and wrong for the `filter-ready` that arrives
after a slow lookup, so a consumer that pages before its rules load should ignore a ready
event carrying no state.

`ui-combobox`'s panel, `ui-table`'s column chooser and `ui-menu`'s dropdown all go through
`open-panel.js`, which owns what an open panel owes whichever element opened it: dismissal
on an outside pointer and on Escape with focus back on the trigger, the
`aria-expanded`/`aria-controls` pair, and the one call that undoes all of it.

The first two are `popover` elements it also positions. The two obvious alternatives both
fail: a panel in the flow pushes the page down when it opens, and an absolutely positioned
one is clipped by the first ancestor with `overflow: hidden` — which is every card with
rounded corners. In the top layer neither applies. `ui-menu` declines the placement with
`anchor: null` and keeps the rest, because a header dropdown is already placed by the two
utility classes the consumer wrote ([ADR-0078](../adr/0078-an-open-panel-is-one-module.md)).

## Forms

Two layers, split where the DOM starts. `@core/forms` holds the state and knows nothing
about elements; `<ui-field>` is the element and holds no state of its own. Both exist
because the alternative was measured first: a nine-field screen written with nothing but
native inputs and the template dialect cost 321 lines of component JavaScript and 236 of
markup, about 21 lines per field.

```js
import { field } from '@core/forms/field.js';
import { group } from '@core/forms/group.js';
import { email, maxLength, required } from '@core/forms/validators.js';

form = group({
  name: field('', [required(), maxLength(80)]),
  email: field('', [required(), email()]),
});
```

```html
<ui-field name="email" label="{{ t('customer.email') }}" required [.field]="form.fields.email">
  <input id="cf-email" type="email" class="…" />
</ui-field>
```

A field carries `value`, `touched`, `submitted`, `serverError` and the derived `error`,
`visibleError`, `valid`, `dirty` and `disabled` — all signals — plus `setValue()`,
`touch()`, `setDisabled()` and `reset()`. A group aggregates them and adds `values`,
`markSubmitted()`, `applyErrors()`, `firstInvalid`, `disabled`, `setDisabled()`, `patch()`
and `reset()`. A group's member may be a field, another group, or a `fieldArray` — see
[repeating rows](#repeating-rows) below. Five rules are worth knowing because they are
decisions rather than mechanics:

- **A validator returns a code, never a sentence.** `ui-field` resolves it: the
  collection's own codes through standard text under `ui.field.*`, an application's
  through the `messages` property. A message frozen at module evaluation could not follow
  a language change, and a validator that imported `t()` would decide an application's
  wording from inside the framework.
- **An error is visible once its field has been left, or once the form has been
  submitted.** Validity and visibility are different questions, and answering them with
  one flag is what greets a user with four errors before they have typed anything.
- **The server outranks every validator, and `setValue` clears its answer.** A 422
  describes the value that was *sent*; left in place it outlives the correction. It does
  not make the field invalid either, or the form would refuse the submit that is the only
  way to find out whether the new value is acceptable.
- **Values stay in whatever shape the control holds**, usually a string, and are
  converted once at the service boundary. `Number('')` is `0`, so a form that converts
  per keystroke cannot tell an empty amount from a deliberate zero.
- **A disabled field stops being answerable for, and keeps its value.** Its validators do
  not run, it reports `valid` and it shows nothing — a rule the user cannot reach and
  cannot fix must not be what refuses a submit. Angular also drops the value out of the
  group, and that half is deliberately not copied: `group.values` is what the screen
  sends, so a form that disables a field for a read-only user would quietly turn its `PUT`
  into a partial one. `dirty` is unaffected for the same reason. A field disabled on its
  own stays disabled when the group is enabled — `field.setDisabled()` and
  `group.setDisabled()` are two sources, so a form switched off while it saves does not
  switch on the one field a domain rule had switched off all along.

<a id="repeating-rows"></a>

**Repeating rows and nesting.** A member of a group is anything satisfying the
`FormNode` contract in `@core/forms/types.js`, which is a field, a group, or an array of them.
There is no `AbstractControl`: `FormNode` is an interface, the three classes are
unrelated, and `@implements` is what stops them drifting apart.

```js
import { fieldArray } from '@core/forms/array.js';

form = group({
  name: field('', [required()]),
  contacts: fieldArray(() =>
    group({
      name: field('', [required()]),
      email: field('', [required(), email()]),
    }),
  ),
});

form.fields.contacts.push();            // an empty row; the form is now dirty
form.fields.contacts.removeAt(0);
form.values;                            // { name: '…', contacts: [{ name: '…', email: '…' }] }
```

```html
<div *for="row of form.fields.contacts.rows; key: row.key">
  <ui-field name="contacts.{{ row.index }}.email" [.field]="row.control.fields.email">
    <input type="email" class="…" />
  </ui-field>
</div>
```

- **A name is a path, and one convention addresses a control at any depth.**
  `contacts.1.email` is what `firstInvalid` reports, what `applyErrors` resolves, what a
  422 from `example/server/api.mjs` carries, and what `<ui-field name>` is bound to — so
  `focusInvalidField` still finds the control with one `querySelector` and a server error
  on the second contact puts the caret in the second contact. For a flat form a path is
  just a field name, which is why nothing about a flat form changed.
- **`key` is the row's identity, `index` is its position.** Keys are minted per array and
  never reused. A keyed `*for` tracking the index would see removing the first row as
  every row below it changing its contents; tracking the key sees one row leave.
- **Adding or removing a row is an unsaved change.** The dirty baseline is the list of
  keys, not the number of rows: remove one contact and add another and the count is back
  where it started while the data is not, so a guard comparing lengths would let the user
  walk away from the deletion. `reset()` puts the removed rows back at the values they
  held.
- **A row added after a submit starts quiet.** `markSubmitted()` makes every error below
  it visible; a row created afterwards does not inherit that, because three red messages
  under a row the user just asked for is the greeting the timing rule exists to prevent.
  The next submit marks it like everything else.
- **A code naming a container is reported, not placed.** `applyErrors({ contacts:
  'tooMany' })` returns `contacts` as unmatched, because there is no control on screen for
  "the contacts" and putting it under a row that did not cause it would be worse than
  telling the screen it could not be placed.
- **Disabled reaches rows built later.** A row inherits the array's state, which inherits
  the form's, so a form switched off while it saves also switches off a contact added
  while it was saving.

An id written into markup is the one thing a repeating row cannot have — the second row
would carry the same one. Rows leave the `id` off their controls and let `ui-field`
generate one per instance, which is also what ties the label, the error and
`aria-describedby` together per row.

The control is projected, not generated: a field that rendered its own `<input>` would
need a property for every attribute an input has and would still be missing the
twentieth. Native `<input>`, `<textarea>` and `<select>` need nothing beyond their
`disabled` property, which `ui-field` sets. Anything else implements the seven-member
`FormControl` contract in `source/components/inputs/form-control.js` — `formValue`,
`formEvent`, `focusControl()`, `setInvalid()`, `setDescribedBy()`, `setLabelledBy()`,
`setDisabled()` — which is how `ui-combobox`
becomes a form field despite holding options rather than codes and generating the node
that takes focus. `ui-date-range` deliberately does not implement it: it is an inline
editor with its own confirm, so its value commits on a button rather than on a change,
and no screen has wanted one inside a form. That is the trigger to revisit.

**Reading and editing are one screen, and the mode is the URL.**
`example/src/pages/sales/customer-detail-page.js` renders nine fields once:
`/sales/customers/:id` disables the group and shows an Edit control,
`/sales/customers/:id?edit=true` enables it, `/sales/customers/new` is the create route.
Nothing holds an `editing` flag — the mode is a computed over `routeParams`,
`queryParams` and the session's scopes, so it survives a refresh, it is linkable, and the
back button leaves edit mode. A query change on an already-matched route is a re-render
rather than a navigation ([routing](routing.md)), so the form the user is reading is the one that becomes
editable, with no refetch and no remount.

Two things follow from that and are worth knowing before copying the pattern. A query
parameter cannot be a route guard, so `?edit=true` is checked by the screen against
`sales:write` and the server enforces the write itself; only `customers/new` is a guarded
route. And `canDeactivate` never runs when only the query changes, so leaving edit mode
cannot prompt — the screen therefore keeps the edits rather than discarding them
silently, and the prompt still happens on the way out of the screen. An explicit Cancel
is the one control that throws work away.

Leaving a half-filled form is the router's business, not the collection's: a route
declares `canDeactivate`, which is asked deepest-first and only for levels actually being
released — a parameter change or a surviving layout asks nobody. Answering `false` keeps
the user where they are and puts the URL back. `false` is allowed here where a
`canActivate` guard must name a redirect instead, because refusing to leave answers "then
where?" by construction. See `example/src/pages/sales/customer-detail-page.js` for a guard
that resolves against a `<ui-dialog mandatory>` rather than `confirm()` — the native
prompt blocks the event loop, cannot be translated and reads as a browser error, and a
question the guard is holding a promise open for is exactly the one that may not be
dismissed without an answer.

## What may go in the collection

A component belongs here when all four are true:

1. It imports from `@core/`, `@auth/`, `@host/` or another component here, and nothing
   else. An import of `@app/…` means it belongs in that application's `src/`.
2. It takes its content through attributes, properties and projected children. Reading
   the injector for an application service (`USER_SERVICE`) makes it unusable in the next
   application; reading a library token (`AUTH_SESSION`) is fine.
3. Its text comes from the consumer as a property, or from a standard key the consumer's
   bundle answers. A hardcoded English string is a component that cannot be reused in the
   Arabic locale, which this project supports.
4. Nothing about it is a page. Routes, guards and `<x-outlet>` targets are application
   concerns.
