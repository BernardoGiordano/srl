# ADR-0104: Authored markup is a value an element renders

- Status: accepted
- Date: 2026-09-10
- Affects: `source/lib/core/template/dialect.js`, `source/lib/core/template/template.js`, `source/components/data/ui-table-column.js`, `source/components/data/ui-table.js`, `cli/checks/template-check.mjs`, `cli/language-server/semantics.mjs`

## Context

A rich table cell, such as an avatar beside a link, could only be a `renderer(row, index, value)` function that built DOM by hand. That code had no static checks, no i18n globals, no per-binding reactivity and no completion, and nobody reading the page's `.html` could see what the cell looked like.

A cell renders once per row, so its markup can't render where it is written. It also needs a `row` local that the page's template doesn't have.

## Decision

`<template *fragment="cell(row of rows)">` compiles its body to a function and assigns it to the `cell` property of the enclosing element. That element decides where and how often the body renders.

- A fragment is a property binding. Its name converts like `[.max-rows]`, it is refused for the same unsafe names, and it is checked against the property's declared type.
- The checker types the body where it is written. The body sees the page's members, its globals and any enclosing `*for` variables, and each parameter gets the type the property's signature declares.
- `of` names where a local's type comes from, as it does in `*for`. `ui-table-column` can only declare rows as `unknown`, so the page states the row type. The runtime ignores the clause.
- A rendered fragment is a lit directive, so its scope follows its DOM position and moves with a keyed row.
- A `<template>` with no fragment head, or with no element to belong to, is an error, because its children would otherwise never render.

A table-only cell template was rejected, since it needs a second compiler. Letting the table supply the scope was rejected, since a cell could then read the table's private members.

## Consequences

- The example's hand-built cells are now `<template *fragment>` blocks that use `*if` and i18n.
- `renderer` stays for cells computed from data the markup can't name. A column with both uses the fragment.
- A fragment parameter shadows an enclosing `*for` variable with the same name.
