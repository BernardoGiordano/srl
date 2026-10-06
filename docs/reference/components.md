# Components

Generated from `cli/project-model/`, the model the template checker and the
language server read. Every element the library and the shared collection
define, with the names a template can bind, listen to and project. An input
whose attribute is spelled differently shows the attribute in parentheses.
`npm run docs:write` regenerates the page, and the same model writes the
package's `custom-elements.json`.

<!-- generated:components -->

### `<ui-app-shell>`

`UiAppShell`, defined in `source/components/shell/ui-app-shell.js`.

| Surface | Names |
|---|---|
| Inputs | `backdropClass` (`backdrop-class`), `drawerOpen` (`data-drawer-open`) |
| Observed attributes | `backdrop-class`, `data-drawer-open` |
| Events | none |
| Projection | default, `sidebar` |
| Uses | none |

### `<ui-avatar>`

`UiAvatar`, defined in `source/components/shell/ui-avatar.js`.

| Surface | Names |
|---|---|
| Inputs | `fallbackClass` (`fallback-class`), `imageClass` (`image-class`), `initials`, `name`, `src` |
| Observed attributes | `fallback-class`, `image-class`, `initials`, `name`, `src` |
| Events | none |
| Projection | none |
| Uses | none |

### `<ui-breadcrumb>`

`UiBreadcrumb`, defined in `source/components/shell/ui-breadcrumb.js`.

| Surface | Names |
|---|---|
| Inputs | `currentClass` (`current-class`), `itemClass` (`item-class`), `items`, `label`, `linkClass` (`link-class`), `listClass` (`list-class`), `separator`, `separatorClass` (`separator-class`) |
| Observed attributes | `current-class`, `item-class`, `label`, `link-class`, `list-class`, `separator`, `separator-class` |
| Events | none |
| Projection | none |
| Uses | none |

### `<ui-combobox>`

`UiCombobox`, defined in `source/components/inputs/ui-combobox.js`.

| Surface | Names |
|---|---|
| Inputs | `addTag`, `addTagLabel` (`add-tag-label`), `chipClass` (`chip-class`), `chipRenderer`, `clearable`, `clearSearchOnAdd` (`clear-search-on-add`), `compareWith`, `controlClass` (`control-class`), `disabled`, `expandedOption`, `groupRenderer`, `hideSelected` (`hide-selected`), `inputClass` (`input-class`), `label`, `loading`, `multiple`, `notFoundLabel` (`not-found-label`), `notFoundRenderer`, `open` (`data-open`), `optionClass` (`option-class`), `optionExpansion`, `optionRenderer`, `options`, `panelClass` (`panel-class`), `placeholder`, `searchable`, `searchFn`, `value` |
| Observed attributes | `add-tag-label`, `chip-class`, `clear-search-on-add`, `clearable`, `control-class`, `data-open`, `disabled`, `hide-selected`, `input-class`, `label`, `loading`, `multiple`, `not-found-label`, `option-class`, `panel-class`, `placeholder`, `searchable` |
| Events | `option-add`, `option-remove`, `panel-close`, `panel-open`, `search-change`, `selection-change`, `selection-clear` |
| Projection | none |
| Uses | none |

### `<ui-date-range>`

`UiDateRange`, defined in `source/components/inputs/ui-date-range.js`.

| Surface | Names |
|---|---|
| Inputs | `autoFocus` (`auto-focus`), `formClass` (`form-class`), `max`, `min`, `range` |
| Observed attributes | `auto-focus`, `form-class`, `max`, `min`, `range` |
| Events | `range-cancel`, `range-confirm` |
| Projection | none |
| Uses | none |

### `<ui-dialog>`

`UiDialog`, defined in `source/components/overlays/ui-dialog.js`.

| Surface | Names |
|---|---|
| Inputs | `alert`, `label`, `mandatory`, `open` (`data-open`), `panelClass` (`panel-class`) |
| Observed attributes | `alert`, `data-open`, `label`, `mandatory`, `panel-class` |
| Events | `close` |
| Projection | default |
| Uses | none |

### `<ui-dynamic-filter>`

`UiDynamicFilter`, defined in `source/components/data/ui-dynamic-filter.js`.

| Surface | Names |
|---|---|
| Inputs | `comboboxClass` (`combobox-class`), `disabled`, `label`, `loading`, `locale`, `name`, `persist`, `placeholder`, `rules` |
| Observed attributes | `combobox-class`, `disabled`, `label`, `loading`, `locale`, `name`, `persist`, `placeholder` |
| Events | `filter-change`, `filter-ready` |
| Projection | none |
| Uses | `ui-combobox`, `ui-date-range` |

### `<ui-field>`

`UiField`, defined in `source/components/inputs/ui-field.js`.

| Surface | Names |
|---|---|
| Inputs | `errorClass` (`error-class`), `field`, `fieldClass` (`field-class`), `hint`, `hintClass` (`hint-class`), `label`, `labelClass` (`label-class`), `messages`, `name`, `required` |
| Observed attributes | `error-class`, `field-class`, `hint`, `hint-class`, `label`, `label-class`, `name`, `required` |
| Events | none |
| Projection | default |
| Uses | none |

### `<ui-form-error>`

`UiFormError`, defined in `source/components/inputs/ui-form-error.js`.

| Surface | Names |
|---|---|
| Inputs | `errorClass` (`error-class`), `messages`, `name`, `node` |
| Observed attributes | `error-class`, `name` |
| Events | none |
| Projection | none |
| Uses | none |

### `<ui-menu>`

`UiMenu`, defined in `source/components/shell/ui-menu.js`.

| Surface | Names |
|---|---|
| Inputs | `label`, `open` (`data-open`), `panelClass` (`panel-class`), `panelRole` (`panel-role`), `triggerClass` (`trigger-class`) |
| Observed attributes | `data-open`, `label`, `panel-class`, `panel-role`, `trigger-class` |
| Events | none |
| Projection | default, `trigger` |
| Uses | none |

### `<ui-sidebar>`

`UiSidebar`, defined in `source/components/shell/ui-sidebar.js`.

| Surface | Names |
|---|---|
| Inputs | `collapsed` (`data-collapsed`), `storageKey` (`storage-key`) |
| Observed attributes | `data-collapsed`, `storage-key` |
| Events | none |
| Projection | default |
| Uses | none |

### `<ui-sidebar-group>`

`UiSidebarGroup`, defined in `source/components/shell/ui-sidebar-group.js`.

| Surface | Names |
|---|---|
| Inputs | `label`, `match`, `open`, `panelClass` (`panel-class`), `triggerClass` (`trigger-class`) |
| Observed attributes | `label`, `match`, `open`, `panel-class`, `trigger-class` |
| Events | none |
| Projection | default, `trigger` |
| Uses | none |

### `<ui-sidebar-item>`

`UiSidebarItem`, defined in `source/components/shell/ui-sidebar-item.js`.

| Surface | Names |
|---|---|
| Inputs | `activeClass` (`active-class`), `exact`, `href`, `linkClass` (`link-class`) |
| Observed attributes | `active-class`, `exact`, `href`, `link-class` |
| Events | none |
| Projection | default |
| Uses | none |

### `<ui-sidebar-toggle>`

`UiSidebarToggle`, defined in `source/components/shell/ui-sidebar-toggle.js`.

| Surface | Names |
|---|---|
| Inputs | `buttonClass` (`button-class`), `for`, `label` |
| Observed attributes | `button-class`, `for`, `label` |
| Events | none |
| Projection | default |
| Uses | none |

### `<ui-table>`

`UiTable`, defined in `source/components/data/ui-table.js`.

| Surface | Names |
|---|---|
| Inputs | `caption`, `columnChooser` (`column-chooser`), `columnsOpen` (`columns-open`), `emptyLabel` (`empty-label`), `filterPredicate`, `filters`, `interactive`, `loading`, `page`, `pageSize` (`page-size`), `pageSizes` (`page-sizes`), `pagination`, `persistFilters` (`persist-filters`), `reorderableColumns` (`reorderable-columns`), `resizableColumns` (`resizable-columns`), `rowHeight` (`row-height`), `rowKey`, `rows`, `rowSelectable`, `selectable`, `selectedKeys`, `sortDirection` (`sort-direction`), `sortKey` (`sort-key`), `stateId` (`state-id`), `tableClass` (`table-class`), `tableName` (`table-name`), `totalRows` (`total-rows`), `viewportHeight` (`viewport-height`), `virtualized` |
| Observed attributes | `caption`, `column-chooser`, `columns-open`, `empty-label`, `interactive`, `loading`, `page`, `page-size`, `page-sizes`, `pagination`, `persist-filters`, `reorderable-columns`, `resizable-columns`, `row-height`, `selectable`, `sort-direction`, `sort-key`, `state-id`, `table-class`, `table-name`, `total-rows`, `viewport-height`, `virtualized` |
| Events | `column-change`, `filter-change`, `load-more`, `page-change`, `query-change`, `row-activate`, `selection-change`, `sort-change`, `state-change`, `state-restore` |
| Projection | default |
| Uses | `ui-table-column` |

### `<ui-table-column>`

`UiTableColumn`, defined in `source/components/data/ui-table-column.js`.

| Surface | Names |
|---|---|
| Inputs | none |
| Observed attributes | `cell-class`, `header-class`, `hidden`, `hideable`, `key`, `label`, `locked`, `max-width`, `min-width`, `resizable`, `sort-key`, `sort-start`, `sortable`, `sticky`, `width` |
| Events | `ui-column-change` |
| Projection | none |
| Uses | none |

### `<ui-topbar>`

`UiTopbar`, defined in `source/components/shell/ui-topbar.js`.

| Surface | Names |
|---|---|
| Inputs | `stuckOffset` (`stuck-offset`) |
| Observed attributes | `stuck-offset` |
| Events | none |
| Projection | default |
| Uses | none |

### `<x-outlet>`

`ComponentOutlet`, defined in `source/lib/core/elements/outlet.js`.

| Surface | Names |
|---|---|
| Inputs | none |
| Observed attributes | none |
| Events | `outlet-error` |
| Projection | none |
| Uses | none |

### `<x-route-outlet>`

`RouteOutlet`, defined in `source/lib/core/navigation/router.js`.

| Surface | Names |
|---|---|
| Inputs | none |
| Observed attributes | none |
| Events | none |
| Projection | none |
| Uses | none |

<!-- /generated:components -->
