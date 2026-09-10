# ADR-0104: Authored markup is a value an element renders

- Status: accepted
- Date: 2026-09-10
- Affects: `source/lib/core/template/dialect.js`, `source/lib/core/template/template.js`, `source/lib/core/template/types.d.ts`, `source/components/data/ui-table-column.js`, `source/components/data/ui-table.js`, `cli/checks/template-check.mjs`, `cli/language-server/semantics.mjs`, `example/src/pages/people/employees-page.html`, `example/src/pages/inventory/products-page.html`

## Context

A component could render markup for itself and for its children, and for nothing else. So a
rich table cell — an avatar beside a link, a number beside a conditional badge — had one
route: `renderer(row, index, value)`, a function on the page returning a node. The example
pays that bill twice. `employees-page.js` built eleven DOM nodes by hand to draw a name
cell, and `products-page.js` built a stock cell the same way.

Everything the compiler gives markup was missing from those functions. No static check on
the tags or the attributes, no i18n through the template globals, no per-binding reactivity,
no completion, and no way for anyone reading the page's `.html` to see what a cell looks
like. `docs/known-gaps.md` recorded the shape of the fix and its risk in the same sentence:
a lexical `row` local inside a consumer's `.html` needs a general template-fragment
primitive, and a table-only second template language is the wrong way to get it.

The two obstacles were real. A cell must render once per row, so the markup cannot be
rendered where it is written; and it has to name a member of a row, so it needs a local the
declaring template does not have.

## Decision

**Markup can be a value.** `<template *fragment="cell(row of rows)">` compiles to a function
and assigns it to the named property of the element it is written inside. The `<template>`
renders nothing where it sits, and the element it belongs to decides where, and how many
times, the body renders. `ui-table-column` gains a `cell` property; the table calls it with
`(row, index, value)`, which is what `renderer` already received.

**A fragment is a property binding.** The name is kebab-cased and converted like `[.max-rows]`,
it is refused for the names every property binding refuses — an event property, a forbidden
member, a sink that writes markup or a URL — and it is checked against the property's
declared type. So an element declares that it renders a fragment the same way it declares
any other input, and no element needs to know the word "fragment" to receive one.

**The body is checked where it is written.** The checker emits it as an arrow assigned to
the property, so contextual typing gives every parameter the type the consumer's signature
declares, and the body reads the declaring component's members, its globals and its
enclosing `*for` variables. A fragment whose body names a field a row does not have is a
build error in the page's own `.html`.

**`of` names where a local's type comes from.** It means what it means in `*for` — one
element of that iterable. A table works for rows of any shape, so `ui-table-column` can only
declare `unknown`, and a dialect with no cast cannot name a member of `unknown`. The page
knows the row type and says it once, in the expression language it already uses. The runtime
ignores the clause: a local holds whatever the consumer passed.

**A rendered fragment keeps its scope per DOM position.** The instance is a Lit directive, so
it lives exactly as long as the part it was committed to, and a keyed `*for` that moves a row
moves the cell's scope with it. Locals are written in place and the version moves only when a
local or the declaring scope changed, which is [ADR-0018](0018-binding-scopes-keep-their-identity.md)'s
rule applied to a position rather than to an index.

**`<template>` means fragment and nothing else.** A template element that reaches the
compiler with no head, or with a head and no element to belong to, is refused by both
adapters. The HTML parser parks a template's children in `content`, where nothing would
compile them, so the alternative to an error is markup that silently never renders.

**Rejected: a table-only cell template.** The table would have to interpret markup, which
means a second compiler, or accept a compiled body, which is this primitive with one
consumer hard-coded. `docs/known-gaps.md` named this as the wrong answer before there was
an implementation to compare it against.

**Rejected: a scope the consumer supplies.** Letting `ui-table` pass a host as well as
locals would let a cell read the *table's* members, which is a component's private surface,
and would make the same fragment mean different things in different tables. The declaring
scope is fixed at compile time.

**Rejected: caching row scopes inside the fragment.** The consumer would have to invent a
key, keep it in step with its own rows, and drop entries nobody told it about. Lit already
tracks a position in the DOM, and a directive instance is that tracking.

**Rejected: dropping `renderer`.** A cell computed from data the markup has no name for is a
real case, and the property is a working adapter. A column carrying both renders the
fragment, because the fragment is the more specific declaration and returns a renderable
even when the row holds nothing at the column's key.

## Consequences

The example loses two hand-built cells and gains two `<template *fragment>` blocks. The stock
cell's conditional badge is now `*if` rather than an `if` statement around `createElement`,
and `num` is no longer imported by a page that only ever used it to fill a cell.

`docs/known-gaps.md` loses the cell-template entry from the collection's open features. The
rest of that list — selection, export, virtualisation, responsive row collapse — is
unaffected, and none of them is closer for this change.

The language server types fragment locals through `__Param<T, N>` over the property's
signature rather than by emitting an arrow, because it needs the types and not the
verification. Both sides read the head through `parseFragmentHead` in the dialect, which is
the seam that keeps a parameter list from being split two ways. The editor closes an
unterminated head before reading it, so completion works while one is being typed; the
runtime and the checker do not.

A fragment sees its parameters as own properties of a chained locals object, so a parameter
named after an enclosing `*for` variable shadows it. Comparing values would not have been
enough — the outer value can be equal to the inner one — so the write is decided by
`Object.hasOwn`.

**What would reopen it:** a consumer that needs a fragment to render before it knows what to
pass, or one that needs the same fragment under two different declaring scopes. Both would
mean the fragment function is the wrong shape, and the current one deliberately answers
neither.
