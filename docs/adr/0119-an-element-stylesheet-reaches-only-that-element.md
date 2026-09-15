# ADR-0119: An Element's stylesheet reaches only that Element

- Status: accepted
- Date: 2026-09-15
- Affects: `source/lib/core/elements/style-scope.js`, `source/lib/core/elements/stylesheet.js`, `source/lib/core/elements/component.js`, `source/lib/core/elements/types.d.ts`, `source/lib/core/template/template.js`, `source/components/style.css`, `source/components/data/ui-table.html`, `source/components/inputs/ui-combobox.html`, `cli/delivery/build.mjs`, `cli/dev/update-client.js`, `cli/project-model/parse.mjs`, `cli/project-model/index.mjs`, `cli/project-model/types.d.ts`, `tools/checks/verify-deps.mjs`, `example/src/ui/`, `source/lib/test/elements/stylesheet.test.js`, `cli/test/project-model.test.mjs`

## Context

An Element had no stylesheet of its own. The example said which box each of its
components is (`app-card { display: block }`) twice, once in `index.html` for Tailwind's
browser build and once in `src/app.css` for the CLI, and a comment in each asked the reader
to keep them in step. The build and the development update client each decided what a
`.css` file was without the Element model knowing either answer. Issue #3 asked for
component-scoped stylesheets and did not say what scoped should mean.

It means that an Element's rules apply to that Element and to the markup its own template
renders, and nothing else in the program can be reached by them. Markup a caller projects
into the Element keeps the caller's styling. A card nested inside a card answers for
itself. A page cannot be restyled by a component it happens to contain.

The same inspection found that the collection's defaults did not do what they promised.
`source/components/style.css` wrapped every selector in `:where()` so that "a Tailwind
utility or an application class always wins", but the file was unlayered and Tailwind v4
puts every utility in `@layer utilities`. An unlayered declaration beats every layered one
whatever its specificity, which is exactly the trap
[ADR-0001](0001-element-defaults-in-their-own-cascade-layer.md) describes. The example's
compiled stylesheet, run in Chromium, left `<app-card class="hidden">` at `display: block`
and `<ui-topbar class="bg-brand">` white. Three collection templates carried utilities that
only rendered correctly because they lost: a table row's `bg-surface` against its hover
colour, a page button's `border-ui-border text-ink hover:bg-canvas` against the current
page's colours, and a combobox control's border against its open accent.

**Rejected: shadow roots.** They are isolation, and they end light-DOM projection and a
document-level Tailwind stylesheet reaching component markup, both of which are
[invariants](../invariants.md).

**Rejected: a positional scope alone.** `@scope (app-card) to (x-content)` keeps projected
markup out. It also keeps out markup the Element itself projects into a nested component,
such as a page's own grid inside the card it renders, because a scope limit cannot be
re-entered below the point where it stops.

**Rejected: an ownership stamp alone**, which is Angular's emulated encapsulation.
`:host([flush]) .body` rewritten to `app-card[flush] .body[owner]` also matches the body of
an unflushed card nested inside a flushed one.

**Rejected: one `<style>` element per Element.** Tailwind's browser build injects its own
`<style>` later and declares its layer order there. A style element inserted first
declares `components` first, which sorts it under `base` and lets preflight undo it.

**Rejected: one emitted `.css` file per Element.** It revisits the artifact's
exactly-one-stylesheet rule and the worker's precache
([ADR-0088](0088-the-service-worker-is-generated-from-the-artifact-report.md)), and a lazily loaded
route would be unstyled offline. Nothing yet measures a stylesheet large enough to want
lazy delivery.

## Decision

**An Element declares a stylesheet with `styles: true`, and the file is its module's
sibling `.css`.** It is never named, for the reason a template is not. An Element with
`template: false` cannot declare one, because its rules would have no markup to reach.

**Ownership is lexical and stamped by the compiler.** A template compiled for a styled
Element writes `data-ui-owner="<tag>"` on every element it renders, including the bodies of
`*for`, `*if` and `*fragment`. Authored markup may not write that attribute. One template
URL has one owner, because one URL has one compile
([ADR-0014](0014-compiled-templates-are-cached-per-url.md)).

**One function scopes the text, and every caller uses it.**
`scopeStylesheet` in `@core/elements/style-scope.js` wraps the rules in
`@layer components { @scope (<tag>) to (:scope <tag>) { … } }` and adds
`:where([data-ui-owner="<tag>"])` to the compound each rule styles. The stamp keeps
projected markup out, and the scope makes `:host` answer for the nearest instance.
`:host` and `:host(<selector>)` become `:scope`, and they are the only way a rule may name
context outside the Element, as in `[data-theme='dark'] :host .title`. A nested rule whose
subject is `&` is left to its parent. The function has no DOM, so the browser, the build and
the project model produce the same bytes. It refuses what it cannot scope, and the refusal
names the line:

- a Tailwind directive, because the browser reads this file as plain CSS in development
- `@import` and `@layer`, because the layer is this function's decision
- a definition whose name the whole document shares, such as `@keyframes` or `@font-face`
- a shadow-DOM selector

**The layer is Tailwind's `components`.** It sorts above preflight and below every
utility. `style.css` declares Tailwind's own order on its first line and puts the
collection's defaults in the same layer. Within that layer, zero specificity leaves any
Element rule ahead of a collection default, and an unlayered application rule still
outranks both.

**Each delivery path uses the same scoped text.**

| Path | What happens |
|---|---|
| Source | `defineComponent` fetches and scopes the sheet, then adopts it with `document.adoptedStyleSheets`, all before `customElements.define` |
| Production | The template transform rewrites `styles: true` to `styles: 'bundled'` and makes the module import a virtual CSS module holding the scoped rules; `cssCodeSplit: false` folds every chunk's rules into the one stylesheet, and the build fails if a bundled Element's `@scope` is missing from it |
| Development edit | `update-client.js` hands an owned `.css` to `reviseStylesheet`, which replaces the adopted sheet's rules in place |

**The static model knows the file.** An `ElementRecord` carries `stylesheet` and
`stylesheetExists`. `npm run verify` refuses a missing sheet as `deps/missing-stylesheet`,
and a sheet the function would refuse as `deps/stylesheet`, at its line and column.

**Collection templates stop carrying utilities that contradict `style.css`.** A row's
surface, a page button's resting and hover colours and a combobox control's border are
the stylesheet's again, and ordered so the state rules win.

The mechanism was probed on Chromium 153, Firefox 155 and WebKit 26.6 with one fixture page.
All three engines kept projected markup unstyled, answered `:host([flush])` per instance,
let a utility beat an Element rule, let an Element rule beat preflight, and matched
nesting, pseudo-elements and a `:host`-qualified ancestor.

## Consequences

The example states which box each of its components is once, in the component's own
stylesheet, and the build and the editor refuse the same broken sheet the browser would.

A utility class now beats a collection default, as the documentation always said. An
application that happened to rely on a default beating its own utility, which is the
bug above, sees its utility.

A styled Element costs one attribute on every element it renders. Unstyled Elements cost
nothing, because their templates are compiled without an owner.

Scope proximity is part of the cascade. An Element's own `:host` rule is nearer to its host
than a parent's rule for the same element, so it wins at equal specificity. A parent that
must win uses a more specific selector or a utility at the call site.

Markup the template did not render carries no stamp and none of the rules. That includes
nodes created in JavaScript and markup written through a trusted HTML sink.

Two Elements declared in one module cannot both have a stylesheet, because they would share
the one sibling file. Each needs a module of its own.

An Element's stylesheet cannot use Tailwind directives, and names like `@keyframes` belong
in the application stylesheet. Colours come from `var(--ui-color-*)`, as they do in
`style.css`.

The `@theme inline` aliases in the example are still written twice. They are Tailwind's
names for tokens rather than an Element's styles, and the known gap says so.

**What would reopen it:** an engine in the support matrix without `@scope`. A measured
stylesheet large enough to want per-route delivery, which reopens one file per Element.
Tailwind renaming or reordering its layers. Or a real need for an Element to define a
global name, which would decide how such names are prefixed.
