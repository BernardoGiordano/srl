# Shared component collection

`source/components` supplies the shell, tables, filters, form controls, and
overlays used by an internal application. Import elements through
`@components/`.

```js
import '@components/shell/ui-sidebar.js';
```

Elements own behavior and accessibility state. Applications choose layout and
classes. State appears in `data-*` attributes so CSS can respond to it.

```html
<ui-sidebar class="group/sidebar w-60 data-collapsed:w-[76px]">
  <span class="group-data-collapsed/sidebar:hidden">Settings</span>
</ui-sidebar>
```

| Element | Main responsibility |
|---|---|
| `ui-app-shell`, `ui-sidebar`, `ui-sidebar-toggle` | Drawer, collapse, and toggle behavior. |
| `ui-sidebar-item`, `ui-sidebar-group` | Active route and open section state. |
| `ui-topbar`, `ui-breadcrumb`, `ui-avatar` | Header semantics, route trail, and image fallback. |
| `ui-menu`, `ui-dialog` | Dismissal, focus, and top-layer behavior. The dialog uses native `<dialog>`. |
| `ui-table`, `ui-table-column` | Table semantics, paging, sorting, selection, windowing, and column preferences. |
| `ui-dynamic-filter`, `ui-date-range` | Filter rules, options, saved values, and date ranges. |
| `ui-combobox` | Searchable selection, chips, keyboard behavior, and a form-control interface. |
| `ui-field`, `ui-form-error` | Labels, values, field errors, and container errors. |

The internal `open-panel.js` module gives menus, comboboxes, and column
choosers consistent placement, Escape and outside-pointer dismissal, and focus
return. `filter-descriptor.js` gives filters and tables one matching vocabulary.
Elements use standard text keys for their own controls; applications supply
labels for their data.

## Tables

The application owns data and declares columns where it uses them.

```html
<ui-table pagination="server" [.rows]="rows" [.total-rows]="total"
          [.filters]="filters" (query-change)="loadQuery($event)">
  <ui-table-column key="supplier.name" label="Supplier" sortable></ui-table-column>
  <ui-table-column key="value" label="Value">
    <template *fragment="cell(order of rows)">
      <a [href]="'/orders/' + order.id">{{ cur(order.value, 'EUR') }}</a>
    </template>
  </ui-table-column>
</ui-table>
```

| Mode | Who processes rows |
|---|---|
| `none` | The table filters and sorts all supplied rows without paging. |
| `client` | The table filters, sorts, and pages supplied rows. |
| `server` | The application fetches one page for each query. |
| `infinite` | The application appends rows when `load-more` fires. |

`query-change` carries page, page size, offset, sort, and filters. Pages start at
one; offsets start at zero. Filter and sort changes reset the page. A rich
cell can use a checked `*fragment` or a `renderer(row, index, value)` function.
`sortValue` and `filterValue` keep raw values separate from displayed markup.

Column options are declared on `ui-table-column`. `hideable` enables the
chooser, `locked` prevents changes, and `sticky="start|end"` pins a column
with logical insets. Reorder and resize work with pointer and keyboard input.

With `selectable`, the table tracks row keys through `rowKey`. Selection
survives sorting and paging. `selection-change` gives keys and the selected
rows currently loaded; a server table cannot provide records from pages it has
not fetched. The application decides what a bulk action means. Selection is
never saved.

`virtualized` renders a window of a page while spacer rows preserve scroll
extent. It keeps page, selection, query, and ARIA row positions for the full
page. Enable it for uniform-height rows and give the table a constrained
viewport. Variable-height rows need another windowing strategy. The
[performance guide](performance.md) records the measured gain.

`state-id` saves page size, sort, column order, visibility, widths, and pinning
through the [preference service](preferences.md). Add `persist-filters` for
JSON-safe filter descriptors. Rows and selection are never saved.
`state-restore` provides the query a server table should fetch after restoring.
`saveState()` writes immediately; normal changes are debounced.

## Filters

`ui-dynamic-filter` displays a screen's rules and active filter chips. The
screen declares rules and receives filter descriptors.

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

| Rule | Options |
|---|---|
| `boolean`, `option`, `date`, `children`, `daterange` | Available from the rule. |
| `free` | Entered by the user. |
| `observer` | Loaded when the filter connects. |
| `lazy` | Loaded when its row opens. |
| `typeahead` | Searched by term. `resolve` restores labels for saved values. |

One `ref` holds one value unless `multiple: true` is set. A rule produces
`equals`, `contains`, or `range` matching as appropriate. The table can
apply the descriptor directly, and an application can provide a predicate
when its data needs different matching.

Date ranges store a half-open interval. The end is exclusive, while the
control shows inclusive days. A preset marked `default: true` applies when
nothing is saved without persisting that default.

Saved filter values are checked against current options. A `lazy` rule loads
its list when a saved value needs it. A `typeahead` rule resolves saved ids
to labels so the active filter remains visible after a reload.

## Forms

`@core/forms` owns state and validation. `<ui-field>` connects that state to
a projected native input or a custom control.

```js
import { field } from '@core/forms/field.js';
import { group } from '@core/forms/group.js';
import { email, required } from '@core/forms/validators.js';

form = group({
  name: field('', [required()]),
  email: field('', [required(), email()]),
});
```

```html
<ui-field name="email" label="{{ t('customer.email') }}" [.field]="form.fields.email">
  <input type="email" />
</ui-field>
```

Validators return message codes. A field shows an error after it is touched or
the form is submitted. Server errors clear when the value changes. Form values
keep the control's type until the service converts them for its API.

A group or array can have its own validator. `<ui-form-error>` displays a
container error without blaming one child. An asynchronous field validator
receives a signal; the field handles debounce, cancellation, pending state,
and its owner's lifetime. A submit waits for `form.whenSettled()` before
checking validity.

Disabled fields keep their values in `group.values`, even though validation
stops for them. This lets a read-only form keep its full record.

<a id="repeating-rows"></a>

A `fieldArray` holds rows with stable keys.

```js
import { fieldArray } from '@core/forms/array.js';

form = group({
  contacts: fieldArray(() => group({
    name: field('', [required()]),
    email: field('', [required(), email()]),
  })),
});
```

```html
<div *for="row of form.fields.contacts.rows; key: row.key">
  <ui-field name="contacts.{{ row.index }}.email"
            [.field]="row.control.fields.email">
    <input type="email" />
  </ui-field>
</div>
```

The row key keeps DOM identity when positions change. The index forms a field
path such as `contacts.1.email`, shared by `applyErrors()`,
`firstInvalid`, and `<ui-field name>`. An added or removed row makes the
array dirty, even if the final row count matches its starting count. Let
`ui-field` generate control ids inside repeated rows.

Native inputs work directly. A custom control implements the
`FormControl` interface in `source/components/inputs/form-control.js`.
`ui-combobox` does so for code values and focus handling.

The example customer screen reads view, edit, and create mode from its URL.
It keeps one form mounted, disables it in view mode, and checks write scope
before editing. A route `canDeactivate` guard asks about unsaved changes
when the user leaves the screen.

## What belongs in the collection

A shared element depends only on library modules or other shared elements.
It receives content through properties, attributes, or projection. Its
interaction text comes from standard keys, while application-specific labels
come from the caller. Pages, routes, and application services stay in the
application.
