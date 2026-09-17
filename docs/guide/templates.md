# Templates and static checking

Components can keep their markup in a sibling `.html` file. The runtime compiles
that file when the component is defined, and the checker reads the same
template grammar before the page runs.

```html
<h1>{{ t('users.title') }}</h1>
<button [?disabled]="isLoading" (click)="reload()">{{ t('users.reload') }}</button>
<p *if="error">{{ error }}</p>
<ul *else>
  <li *for="user of rows; key: user.id">
    <a [href]="'/users/' + user.id">{{ user.name }}</a>
  </li>
</ul>
```

| Syntax | Meaning |
|---|---|
| `{{ expr }}` | Interpolate text or an attribute. |
| `[href]="expr"` | Bind an attribute. |
| `[?disabled]="expr"` | Add or remove a boolean attribute. |
| `[.limit]="expr"` | Bind a property. Kebab-case names map to camelCase. |
| `(click)="expr"` | Handle an event with `$event` in scope. |
| `*if` and `*else` | Render one branch. |
| `*for="u of users; key: u.id"` | Render keyed items. |
| `*for="u of users; index as i"` | Name the row index. |
| `<template *fragment="cell(row of rows)">` | Pass markup to another element. |
| `&expr` | Pass a signal without unwrapping it. |

Each compiled binding tracks the signals it reads and updates its own DOM
part. A handwritten `render()` tracks at component granularity.

The [template dialect reference](../reference/template-dialect.md) lists every
binding form, operator, refused expression, and security context. It is
generated from the modules the runtime and the checker read.

## Structural directives

`*else` goes on the element that follows an `*if` element, with only
whitespace between them. An `*else` anywhere else is refused. One element
cannot carry both `*for` and `*if`, so wrap one of them in an element of its
own.

```html
<ul>
  <li *for="user of rows; key: user.id; index as position">
    <span *if="$first">Newest</span>
    {{ position + 1 }} of {{ $count }}: {{ user.name }}
  </li>
</ul>
```

Each `*for` row has `$index`, `$first`, `$last`, and `$count` in scope besides
its own item. `index as position` gives `$index` a second name, which helps
when `*for` blocks nest. The `key` clause gives each row an identity. Without
it, a reorder re-renders every row. The two clauses may appear in either
order.

## Loading and caching

The compiler creates one stable Lit template identity per template URL. The
browser fetches and compiles it once; later renders patch existing DOM. It
caches the in-flight promise too, so simultaneous mounts share one fetch and
compile.

A built manifest can group template URLs by the code chunk that names them.
Startup begins the entry group, and other groups begin when a component in
their chunk asks for a template. Visitors load markup for the screens they
open. [Delivery](delivery.md#templates-in-a-built-artifact) describes the
other template modes.

Production templates are minified. The build compares the parsed source and
output trees and fails if minification changes their structure. Whitespace
inside `<pre>`, `<textarea>`, `<script>`, `<style>`, and elements with
supported `white-space` declarations stays intact. A custom CSS class that
sets `white-space` cannot be read by the minifier, so mark significant
whitespace on the element itself.

## Expression language

Bindings use a parser and evaluator instead of `eval`. They support member
access, optional chaining, calls, arithmetic, comparisons, ternaries, logical
operators, arrays, and objects. Only an event binding may assign, and only
with `=`. Arrow functions, `new`, template literals, bitwise operators,
`typeof`, `in`, `++`, `+=`, and spread are refused. `==` and `!=` compare
strictly. The [reference](../reference/template-dialect.md#expressions) lists
each construct with the parser's verdict. Templates read public component
members.

Signals unwrap during expression evaluation. Use `&` when another element
needs the signal itself.

```html
<x-outlet [.target]="&panel"></x-outlet>
```

The parser lifts `{{ … }}` expressions before parsing HTML so comparisons
inside them are not mistaken for tags. Property binding names are normalized
to camelCase; expression values keep their spelling.

The language rejects `__proto__`, `constructor`, and `prototype` as member
names for reads, writes, keys, and calls. That rule removes unsafe property
paths from authored expressions.

## Fragments

A fragment lets one component author markup that another renders.

```html
<ui-table-column key="name" label="Name">
  <template *fragment="cell(person of rows)">
    <a [href]="'/people/' + person.id">{{ person.name }}</a>
  </template>
</ui-table-column>
```

`cell` names the receiving property. The consumer supplies arguments to the
fragment, while its body reads the declaring component's members and outer
locals. `of rows` gives `person` the row type for static checking. The
runtime keeps each rendered position's scope while its DOM remains mounted.

## DOM security

Template values are escaped or sanitized for the DOM sink they reach. URL
attributes reject active schemes. Resource-loading sinks require an explicit
trusted resource URL. HTML sinks remove active markup. Unsafe event-handler,
`outerHTML`, prototype, and dynamic style bindings are refused.

The same rules apply to interpolated attributes and property bindings. A
deployment can enforce Trusted Types through its CSP. Review every explicit
bypass beside the validation that makes its value safe.

```js
import { bypassSecurityTrustResourceUrl } from '@core/template/security.js';

get reviewedFrameUrl() {
  const url = new URL(this.reportPath, location.origin);
  if (url.origin !== location.origin) throw new Error('Unexpected report origin');
  return bypassSecurityTrustResourceUrl(url.href);
}
```

Trusted wrappers are tied to one security context and cannot be used as plain
strings.

## Static checking

`srl check templates` discovers component and template pairs through the
project model. It generates type queries in memory and checks expressions
against the component's JSDoc and nearby `.d.ts` files. No runtime file
changes.

The checker covers public members, signal unwrapping, loop locals, branch
narrowing, event targets, custom-element properties, observed attributes,
`uses` entries, and unknown tags. Diagnostics point to the authored HTML, and
each one carries a code such as `templates/unknown-element`.
`srl check --codes` explains every code, and the
[diagnostic code reference](../reference/diagnostic-codes.md) lists them.

A static tool cannot infer every dynamic element declaration. The model marks
such a surface incomplete and avoids claiming unknown members are absent.
Native attributes, `aria-*`, and `data-*` remain available without a
project-specific element declaration.
