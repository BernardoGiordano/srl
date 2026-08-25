# Project index

Generated from `cli/project-model/`, the one AST pass over the source that the
template checker, the dependency verifier, the template bundler and this page all
read. Regenerate with `npm run docs:write`; `npm run docs:check` fails when a table
drifts from the source.

Everything the library and the shared collection define:

<!-- generated:elements -->

| Tag | Class | Module | Template | Uses | Reactive properties | Observed attributes |
|---|---|---|---|---|---|---|
| `ui-app-shell` | `UiAppShell` | `source/components/shell/ui-app-shell.js` | `source/components/shell/ui-app-shell.html` | — | 2 | 2 |
| `ui-avatar` | `UiAvatar` | `source/components/shell/ui-avatar.js` | `source/components/shell/ui-avatar.html` | — | 6 | 5 |
| `ui-breadcrumb` | `UiBreadcrumb` | `source/components/shell/ui-breadcrumb.js` | `source/components/shell/ui-breadcrumb.html` | — | 8 | 7 |
| `ui-combobox` | `UiCombobox` | `source/components/inputs/ui-combobox.js` | `source/components/inputs/ui-combobox.html` | — | 32 | 17 |
| `ui-date-range` | `UiDateRange` | `source/components/inputs/ui-date-range.js` | `source/components/inputs/ui-date-range.html` | — | 8 | 5 |
| `ui-dialog` | `UiDialog` | `source/components/overlays/ui-dialog.js` | `source/components/overlays/ui-dialog.html` | — | 5 | 5 |
| `ui-dynamic-filter` | `UiDynamicFilter` | `source/components/data/ui-dynamic-filter.js` | `source/components/data/ui-dynamic-filter.html` | `ui-combobox`, `ui-date-range` | 12 | 8 |
| `ui-field` | `UiField` | `source/components/inputs/ui-field.js` | `source/components/inputs/ui-field.html` | — | 10 | 8 |
| `ui-menu` | `UiMenu` | `source/components/shell/ui-menu.js` | `source/components/shell/ui-menu.html` | — | 5 | 5 |
| `ui-sidebar` | `UiSidebar` | `source/components/shell/ui-sidebar.js` | `source/components/shell/ui-sidebar.html` | — | 2 | 2 |
| `ui-sidebar-group` | `UiSidebarGroup` | `source/components/shell/ui-sidebar-group.js` | `source/components/shell/ui-sidebar-group.html` | — | 5 | 5 |
| `ui-sidebar-item` | `UiSidebarItem` | `source/components/shell/ui-sidebar-item.js` | `source/components/shell/ui-sidebar-item.html` | — | 4 | 4 |
| `ui-sidebar-toggle` | `UiSidebarToggle` | `source/components/shell/ui-sidebar-toggle.js` | `source/components/shell/ui-sidebar-toggle.html` | — | 3 | 3 |
| `ui-table` | `UiTable` | `source/components/data/ui-table.js` | `source/components/data/ui-table.html` | `ui-table-column` | 23 | 19 |
| `ui-table-column` | `UiTableColumn` | `source/components/data/ui-table-column.js` | — | — | 0 | 15 |
| `ui-topbar` | `UiTopbar` | `source/components/shell/ui-topbar.js` | `source/components/shell/ui-topbar.html` | — | 1 | 1 |
| `x-outlet` | `ComponentOutlet` | `source/lib/core/elements/outlet.js` | — | — | 0 | 0 |
| `x-route-outlet` | `RouteOutlet` | `source/lib/core/navigation/router.js` | — | — | 0 | 0 |

<!-- /generated:elements -->

Names a template may use without importing anything, and where each comes from:

<!-- generated:globals -->

| Name | Module |
|---|---|
| `availableLocales` | `source/lib/core/localization/i18n.js` |
| `cur` | `source/lib/core/localization/i18n.js` |
| `direction` | `source/lib/core/localization/i18n.js` |
| `dt` | `source/lib/core/localization/i18n.js` |
| `isLoadingLocale` | `source/lib/core/localization/i18n.js` |
| `locale` | `source/lib/core/localization/i18n.js` |
| `num` | `source/lib/core/localization/i18n.js` |
| `rel` | `source/lib/core/localization/i18n.js` |
| `setLocale` | `source/lib/core/localization/i18n.js` |
| `t` | `source/lib/core/localization/i18n.js` |

<!-- /generated:globals -->

The applications, discovered rather than configured:

<!-- generated:applications -->

| Application | Entry module | Prefixes it declares | Templates it owns | Elements it declares |
|---|---|---|---|---|
| `example` | `example/src/main.js` | `@auth/` `@components/` `@core/` `@host/` | 36 | 36 |

<!-- /generated:applications -->

Ask the model directly:

```bash
node cli/project-model/index.mjs --element ui-table   # one element and its dependencies
node cli/project-model/index.mjs --json               # the whole index, deterministic
```

The model reports what static analysis cannot read, by severity. An **error** is an
unreadable `defineComponent` in non-test source, a duplicate tag, or a `uses` naming a
class nothing defines; it fails `npm run verify`. Everything else is a **note**,
printed and never fatal — a suite that deliberately declares something the runtime
must reject is a suite doing its job.
