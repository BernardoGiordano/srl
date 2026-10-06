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
| `.srcdoc` | Refused, because lit reads the name as its own binding syntax. |
| `@click` | Refused, because lit reads the name as its own binding syntax. |
| `[@click]` | Refused, because lit reads the name as its own binding syntax. |

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
| Assignment | `selected = row` | no, `templates/expression-assignment` | yes |
| Compound assignment | `count += 1` | no, `templates/expression-syntax` | no, `templates/expression-syntax` |
| Increment | `count++` | no, `templates/expression-syntax` | no, `templates/expression-syntax` |
| Arrow function | `(item) => item.id` | no, `templates/expression-syntax` | no, `templates/expression-syntax` |
| `new` | `new Date()` | no, `templates/expression-syntax` | no, `templates/expression-syntax` |
| Template literal | `` `Hello ${name}` `` | no, `templates/expression-syntax` | no, `templates/expression-syntax` |
| Bitwise operator | `flags \| mask` | no, `templates/expression-syntax` | no, `templates/expression-syntax` |
| `typeof` | `typeof value` | no, `templates/expression-syntax` | no, `templates/expression-syntax` |
| `in` | `'id' in row` | no, `templates/expression-syntax` | no, `templates/expression-syntax` |
| Unary plus | `+value` | no, `templates/expression-syntax` | no, `templates/expression-syntax` |
| Comma operator | `first, second` | no, `templates/expression-syntax` | no, `templates/expression-syntax` |
| Spread | `[...items]` | no, `templates/expression-syntax` | no, `templates/expression-syntax` |
| Computed object key | `{ [key]: value }` | no, `templates/expression-syntax` | no, `templates/expression-syntax` |
| Shorthand object property | `{ id }` | no, `templates/expression-syntax` | no, `templates/expression-syntax` |
| Exponent or hex literal | `1e3` | no, `templates/expression-syntax` | no, `templates/expression-syntax` |
| Regular expression | `/^a/.test(name)` | no, `templates/expression-syntax` | no, `templates/expression-syntax` |
| Reserved member | `user.constructor` | no, `templates/expression-member` | no, `templates/expression-member` |

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

A static `srcdoc` or `innerhtml` attribute is refused, because the sanitizer never
reads it. Bind it instead. An assignment in an event binding, such as
`(click)="target.innerHTML = text"`, and an outlet's props pass the same sink as a
property binding to that element.

## Refused elements

A template may not contain these elements:

<!-- generated:dialect-refused-elements -->

| Element | Why |
|---|---|
| `<script>` | Templates are markup only, so behaviour belongs in the component's .js file. |
| `<base>` | It acts on the whole document, so it belongs in index.html. |
| `<link>` | It acts on the whole document, so it belongs in index.html. |
| `<meta>` | It acts on the whole document, such as a refresh that navigates away, so it belongs in index.html. |

<!-- /generated:dialect-refused-elements -->

A `{{ }}` binding inside one of these elements is refused, and so is a property
binding that replaces its content, such as `[.text-content]`. The HTML parser reads
their content as raw text. In `<style>` a binding would write CSS for the whole page,
and in the others lit can't place one. `<textarea>` and `<title>` take bindings as
text.

<!-- generated:dialect-raw-text-elements -->

`iframe`, `noembed`, `noframes`, `noscript`, `plaintext`, `script`, `style`, `xmp`.

<!-- /generated:dialect-raw-text-elements -->

## Void elements

These elements are never closed and never open a scope:

<!-- generated:dialect-void-elements -->

`area`, `base`, `br`, `col`, `embed`, `hr`, `img`, `input`, `link`, `meta`, `source`, `track`, `wbr`.

<!-- /generated:dialect-void-elements -->
