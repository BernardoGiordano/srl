# Template dialect

Generated from `source/lib/core/template/dialect.js` and `expression-parser.js`, the
modules the runtime compiler and the template checker both read. The tables below
come from the dialect's own tables, or from running the samples through its own
functions. Regenerate with `npm run docs:write`. `npm run docs:check` fails when a
table drifts from the source. The [template guide](../guide/templates.md) explains how
to use the dialect.

## Attributes and bindings

The HTML parser lowercases attribute names before the dialect reads them, so a
property binding is written in kebab-case and maps to camelCase.

<!-- generated:dialect-bindings -->

| Written | Meaning |
|---|---|
| `title` | Static attribute. `{{ }}` inside the value interpolates. |
| `[href]` | Sets attribute `href`. |
| `[?open]` | Adds or removes attribute `open`. |
| `[hidden]` | Adds or removes attribute `hidden`. |
| `[.max-rows]` | Sets property `maxRows`. |
| `(click)` | Listens for `click`. `$event` is in scope. |
| `(value-change)` | Listens for `value-change`. `$event` is in scope. |
| `onclick` | Refused. Bind the event in parentheses. |
| `[onclick]` | Refused. Bind the event in parentheses. |
| `[.onclick]` | Refused. Bind the event in parentheses. |
| `[.constructor]` | Refused, because the name is reserved. |
| `[]` | Refused, because the binding names nothing. |
| `[.]` | Refused, because the binding names nothing. |

<!-- /generated:dialect-bindings -->

A bracketed binding to one of these attributes adds or removes it, with or without
`?`:

<!-- generated:dialect-boolean-attributes -->

`autofocus`, `checked`, `default`, `disabled`, `hidden`, `inert`, `ismap`, `loop`, `multiple`, `muted`, `novalidate`, `open`, `readonly`, `required`, `reversed`, `selected`.

<!-- /generated:dialect-boolean-attributes -->

## Structural directives

- `*if="expr"` renders the element when `expr` is truthy.
- `*else` goes on the element directly after an `*if` element. Only whitespace may sit
  between them. An `*else` anywhere else is refused.
- `*for="item of items"` renders the element once per item. Two optional clauses
  follow, separated by `;`, in any order.
  - `key: expr` gives each row an identity, so a reorder moves rows instead of
    rebuilding them.
  - `index as name` gives `$index` a second name.
- One element cannot carry both `*for` and `*if`. Wrap one in an element of its own.

Every `*for` row has these locals besides its own item:

<!-- generated:dialect-loop-locals -->

| Local | Type | Value |
|---|---|---|
| `$index` | `number` | Position of the row, from 0. |
| `$first` | `boolean` | True for the first row. |
| `$last` | `boolean` | True for the last row. |
| `$count` | `number` | Number of rows in the list. |

<!-- /generated:dialect-loop-locals -->

## Fragments

`<template *fragment="name(params)">` declares markup that the enclosing element
renders later. Only a `<template>` may declare a fragment, and it must sit inside the
element that receives it. A `<template>` without `*fragment` is refused. A parameter
written `row of rows` takes its type from the elements of `rows`.

<!-- generated:dialect-fragments -->

| Head | Meaning |
|---|---|
| `cell(row)` | Assigns property `cell`. Parameters: `row`. |
| `cell(row of rows, index)` | Assigns property `cell`. Parameters: `row`, typed from `rows`; `index`. |
| `empty-state()` | Assigns property `emptyState`. Parameters: none. |
| `cell(row, row)` | Refused. |
| `cell` | Refused. |
| `cell(row.id)` | Refused. |

<!-- /generated:dialect-fragments -->

## Expressions

A binding holds one expression. An event binding may also assign.

<!-- generated:dialect-operators -->

| Binds | Binary operators |
|---|---|
| 1 | `*`, `/`, `%` |
| 2 | `+`, `-` |
| 3 | `<`, `<=`, `>`, `>=` |
| 4 | `===`, `!==`, `==` (as `===`), `!=` (as `!==`) |
| 5 | `&&` |
| 6 | `\|\|` |
| 7 | `??` |

Level 1 binds tightest. The prefix operators are `!`, `&`, `-`, and they bind tighter than every binary operator. A conditional `a ? b : c` binds loosest. `&` passes a signal without reading it.

The word literals are `true`, `false`, `null`, `undefined`. Numbers are decimal, and strings take single or double quotes.

<!-- /generated:dialect-operators -->

<!-- generated:dialect-expressions -->

| Construct | Example | In a binding | In an event binding |
|---|---|---|---|
| Member access | `user.name` | yes | yes |
| Optional chaining | `user?.name` | yes | yes |
| Index access | `row['name']` | yes | yes |
| Call | `format(user.created)` | yes | yes |
| Arithmetic | `price * quantity + 1` | yes | yes |
| Comparison | `count >= 10` | yes | yes |
| Loose equality, compared strictly | `status == 'open'` | yes | yes |
| Logical operators | `ready && !failed` | yes | yes |
| Nullish coalescing | `name ?? 'anonymous'` | yes | yes |
| Conditional | `open ? 'Hide' : 'Show'` | yes | yes |
| Array literal | `[first, second]` | yes | yes |
| Object literal | `{ id: row.id, 'aria-label': label }` | yes | yes |
| Signal reference | `&panel` | yes | yes |
| Assignment | `selected = row` | no | yes |
| Compound assignment | `count += 1` | no | no |
| Increment | `count++` | no | no |
| Arrow function | `(item) => item.id` | no | no |
| `new` | `new Date()` | no | no |
| Template literal | `` `Hello ${name}` `` | no | no |
| Bitwise operator | `flags \| mask` | no | no |
| `typeof` | `typeof value` | no | no |
| `in` | `'id' in row` | no | no |
| Unary plus | `+value` | no | no |
| Comma operator | `first, second` | no | no |
| Spread | `[...items]` | no | no |
| Computed object key | `{ [key]: value }` | no | no |
| Shorthand object property | `{ id }` | no | no |
| Exponent or hex literal | `1e3` | no | no |
| Regular expression | `/^a/.test(name)` | no | no |
| Reserved member | `user.constructor` | no | no |

<!-- /generated:dialect-expressions -->

No expression may read, call, write or build a key with these member names. The
parser refuses them when they are written out, and the evaluator refuses them when a
computed key produces them:

<!-- generated:dialect-members -->

`__proto__`, `constructor`, `prototype`.

<!-- /generated:dialect-members -->

## Security contexts

A value bound to one of these names is sanitized for its context before Lit writes
it. Names compare without case, and an attribute and a property with the same name
share a context. Event-handler attributes and properties are refused outright, as the
binding table shows.

<!-- generated:dialect-sinks -->

| Context | Names | What happens to the value |
|---|---|---|
| `resourceUrl` | `base href`, `embed src`, `frame src`, `iframe src`, `link href`, `object data`, `script src` | Refused unless the value comes from `bypassSecurityTrustResourceUrl`. |
| `html` | `innerhtml`, `srcdoc`, on any element | Active markup is removed. `bypassSecurityTrustHtml` skips that. |
| `style` | `csstext`, `style`, on any element | A value with `url(`, `@import`, `expression(` or a backslash is dropped. `bypassSecurityTrustStyle` skips that. |
| `urlSet` | `srcset`, on any element | Every URL in the list is checked as a URL. `bypassSecurityTrustUrl` skips that. |
| `url` | `action`, `background`, `cite`, `data`, `formaction`, `href`, `manifest`, `poster`, `src`, `xlink:href`, on any element | An active scheme such as `javascript:` gets an `unsafe:` prefix. `bypassSecurityTrustUrl` skips that. |

<!-- /generated:dialect-sinks -->

## Void elements

These elements are never closed and never open a scope:

<!-- generated:dialect-void-elements -->

`area`, `base`, `br`, `col`, `embed`, `hr`, `img`, `input`, `link`, `meta`, `source`, `track`, `wbr`.

<!-- /generated:dialect-void-elements -->
