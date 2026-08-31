# The template language and static checking

```html
<!-- every construct at once; the real ones are under example/src/pages/ -->
<h1>{{ t('users.title') }}</h1>
<span>{{ t('users.count', { count: rows.length }) }}</span>
<button [?disabled]="isLoading" (click)="reload()">{{ t('users.reload') }}</button>

<p *if="error">{{ error }}</p>

<ul *else>
  <li *for="user of rows; key: user.id">
    <a [href]="'/users/' + user.id">{{ user.name }}</a>
    <span class="rounded px-1.5 {{ statusClasses(user) }}">{{ t(statusKey(user)) }}</span>
  </li>
</ul>
```

| Syntax | Meaning |
|---|---|
| `{{ expr }}` | text and attribute interpolation |
| `[href]="expr"` | attribute binding |
| `[?disabled]="expr"` | boolean attribute, removed when false |
| `[.limit]="expr"` | property binding; `[.max-rows]` sets `maxRows` |
| `(click)="expr"` | event listener, with `$event` in scope |
| `*if` / `*else` | conditional; `*else` goes on the next element |
| `*for="u of users; key: u.id; index as i"` | repetition, keyed |
| `&expr` | resolve without unwrapping a signal |

Each compiled binding tracks its own signal dependencies and updates its own Lit part.
Changing a signal used by one interpolation, attribute, property or structural
directive does not reevaluate the component's unrelated bindings or call `render()`
again. A hand-written JavaScript `render()` stays tracked at component granularity.

## Why it is not slow

lit-html caches a parsed template against the **identity** of the
`TemplateStringsArray` it was tagged with, and that array does not have to come from a
literal in source: an array carrying a `raw` property behaves identically. Verified in
real Chrome before any of this was designed — a hand-built strings array renders
through lit's `html` tag; the same array on a second render patches the existing DOM in
place; a different array with byte-identical contents builds fresh elements.

So each `.html` file is fetched once, walked once, and compiled to exactly one strings
array plus one closure per binding. Every render after that hands lit the same array:
no re-parse, no `innerHTML`, no string diffing. The third observation is why the
compiled result is cached per URL and never rebuilt.

What is cached per URL is the *promise*, not the compiled result, so two components
mounting at the same moment share one compile instead of racing two. The bytes are cached
separately from the compile, which is what makes the request cheap to start early: by
default a built artifact's `app.manifest.json` lists every template it holds, and startup
calls `prefetchTemplates` with the list, so the markup is in flight while the chunks are
still arriving and each `await` inside a component resolves from the cache. The prefetch
takes the transfer only — a walk of every template in the application ahead of the first
paint would cost more main thread than the round trips it saves — so a template is compiled
when the component that names it is defined, and never before. Without it a chunk holding nine components costs nine requests in a
row, because a component's template URL is not known until that component's module has been
fetched and evaluated ([ADR-0081](../adr/0081-the-manifest-names-every-template.md)).

Nothing about that list changes how a template is delivered: the files stay separate,
hash-named and immutable under every mode. Which of the three a deployment wants —
announce all of them, announce none, or ship one bundle — is
[a build flag](delivery.md#templates-in-a-built-artifact).

## Whitespace in production

A built artifact serves minified markup: comments dropped, each run of whitespace collapsed
to one space, `class` collapsed as the token list it is. A third of the authored bytes in
practice, and nothing rendered differently — the build proves each template parses to the
same tree its source did, and fails naming the template if it does not
([ADR-0070](../adr/0070-a-production-template-is-minified-and-proved-equivalent.md)).

A run of whitespace is collapsed, never removed, because `a<span> </span>b` and
`a<span></span>b` are two different renderings. Whole subtrees are left byte for byte when
the markup says whitespace matters in them:

```html
<pre>  two spaces, and a
   line break  </pre>                        <!-- pre, textarea, script, style -->

<p class="whitespace-pre-line">{{ notes }}</p>   <!-- whitespace-pre, -pre-line, -pre-wrap,
                                                     -break-spaces, [white-space:pre] -->
<p style="white-space: pre-wrap">{{ notes }}</p> <!-- or say it inline -->
```

The one thing the build cannot read is a stylesheet. An element made preformatted by a
class of the application's own — `.log { white-space: pre; }` — holding literal
whitespace-significant text in its template has that whitespace collapsed. Say it on the
element instead, or use `<pre>`.

## Bindings are a language, not `eval`

`new Function` was rejected for two independent reasons. It requires
`script-src 'unsafe-eval'`, the single CSP relaxation most likely to be refused by a
security review — and it would not work anyway, because `this.#users` is unreachable
from any dynamically compiled function.

`core/template/expression.js` is therefore a tokenizer, a precedence-climbing parser
and a closure compiler for a deliberately small language: member access, optional
chaining, calls, arithmetic, comparison, ternary, `??`/`&&`/`||`, array and object
literals, and assignment inside event bindings. No arrow functions, no `new`, no
bitwise operators, no template literals. Angular draws the line in the same place.

Templates read a component's **public** members. That restriction turned out to be an
improvement: a component's template surface is now a handful of getters, and tsc checks
every one of them.

Three details worth knowing before writing a dialect change:

- **Signals auto-unwrap.** Every resolution step reads a `Signal`, inside the render
  effect, which is exactly what registers the dependency. The escape hatch is `&`:
  `<x-outlet [.target]="&panel">` passes the signal itself, so the outlet subscribes
  directly and swapping panels re-renders nothing in the parent.
- **Interpolations are lifted before the HTML parser sees them.** `{{ a < b }}` in text
  content parses as the start of a tag named `b`. Bodies are replaced with placeholders
  first.
- **Attribute names are lowercased by the parser; values are not.** Property bindings
  use kebab-case and convert to camelCase, like `dataset`. Expressions keep their
  casing because they live in values.
- **`__proto__`, `constructor` and `prototype` are refused as member names, in every
  operation.** Not only reads: a direct write, a computed write, an object-literal key
  and a call are the same rule, because the rule is about the name rather than the
  direction the value travels. A name written in the source is refused while parsing,
  so the checker reports it and the browser never compiles it; a key that only exists
  once an event fires — `row[column] = value` — is refused by the evaluator against the
  same list. Templates are authored code rather than user input, so this is not a
  sandbox: it exists so a template can never be the interesting half of a gadget chain.

## DOM security contexts and Trusted Types

Template values are untrusted by default. Text stays escaped; bindings are sanitised
according to the DOM sink they target:

- `href`, ordinary `src`, `srcset`, `action`, `poster` and related URL attributes
  reject active schemes such as `javascript:` and active `data:` payloads;
- resource-loading sinks such as `iframe.src`, `object.data` and `link.href` accept
  only an explicit trusted resource URL;
- `innerHTML` and `srcdoc` remove active elements, event attributes and unsafe URLs;
  dynamic style text rejects URLs, imports, expressions and CSS escapes;
- event-handler, `outerHTML` and prototype property bindings are refused.

The rules apply equally to `[href]="value"`, `href="{{ value }}"` and property
bindings. Under a CSP containing `require-trusted-types-for 'script'` the sanitiser
produces native Trusted Types through the allow-listed `ui-test` policy; the compiler
and Lit use private `ui-test-template` and `lit-html` policies for framework-owned
markup. A deployment enables all three by naming them in its `trusted-types` directive.

The escape hatches are intentionally hard to overlook:

```js
import { bypassSecurityTrustResourceUrl } from '@core/template/security.js';

// Keep the validation and the bypass together. A normal string is rejected in
// this resource-URL context.
get reviewedFrameUrl() {
  const url = new URL(this.reportPath, location.origin);
  if (url.origin !== location.origin) throw new Error('Unexpected report origin');
  return bypassSecurityTrustResourceUrl(url.href);
}
```

Each wrapper is opaque, valid only for its matching context, and throws if it is
stringified accidentally. A URL trusted with `bypassSecurityTrustUrl()` cannot be used
where `bypassSecurityTrustResourceUrl()` is required. Treat every bypass as a
security-review point.

## Static checking without a build

Source is `.js`; types are JSDoc, and each subsystem's non-trivial types live in a
`types.d.ts` beside it in real TypeScript, referenced with one line:

```js
/** @import { Evaluator, ExprNode, Scope } from '@core/template/types.js' */
```

That reference costs zero runtime bytes. `node_modules` exists only so tsc and ESLint
can resolve types for the *same* versions `/lib/vendor` serves; `npm run verify` fails
if the two drift.

`npm run templates:check` discovers every component/template pair through the project
model, generates virtual TypeScript shims in memory, parses expressions with the same
AST parser the browser uses, and asks the TypeScript compiler API to resolve them
against the component class and its JSDoc types. No file is written and nothing changes
in the runtime path. It covers component members, automatic signal unwrapping, nested
`*for` locals, `*if`/`*else` narrowing, native event targets, boolean bindings,
custom-element property assignments, unknown tags, elements the component never
imported, and attributes a custom element does not observe. Diagnostics point back at the
`.html` source.

That last one closes the gap the property check leaves open. `[.emptyLabel]="x"` on an
element with no such property is a type error, but `empty-label="No rows"` is markup: it
reaches the DOM whatever the element does with it, and an element that observes nothing by
that name renders nothing and says nothing. So the checker asks the project model what
each custom element observes — `static properties` mapped through Lit's rule, or
`static observedAttributes` for an element that is configuration rather than a component —
and reports an attribute nothing reacts to:

```text
employees-page.html:22:7 - error: <ui-table> does not observe the attribute pagesize.
                                  Did you mean page-size?
employees-page.html:24:7 - error: <ui-table> declares rows as a property with no attribute,
                                  so rows does nothing. Bind it as [.rows].
```

Three deliberate limits. Native elements are unchecked, because nothing here holds
`<input>`'s attribute set. Global, `aria-*` and `data-*` attributes belong to every
element. And an element whose surface no static tool can read — a class built inside a
function, handed to `defineComponent` by a loader — is skipped rather than guessed at:
the model reports that surface as unknown, and unknown is not empty.

Two frictions of JSDoc-based typing worth knowing: a JSDoc cast satisfies tsc but not
typescript-eslint, because it leaves no assertion node in the ESLint AST — `Response
.json()` returning `any` is confined once in `core/foundation/json.js`; and a value
imported only for a JSDoc type reads as unused to ESLint, so use `@import`.
