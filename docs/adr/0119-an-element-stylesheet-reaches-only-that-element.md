# ADR-0119: An Element's stylesheet reaches only that Element

- Status: accepted
- Date: 2026-09-15
- Affects: `source/lib/core/elements/style-scope.js`, `source/lib/core/elements/stylesheet.js`, `source/lib/core/elements/element-defaults.js`, `source/lib/core/elements/component.js`, `source/components/style.css`, `cli/delivery/build.mjs`, `cli/project-model/parse.mjs`, `tools/checks/verify-deps.mjs`

## Context

Elements had no stylesheets of their own. The example repeated rules like `app-card { display: block }` in two files and asked readers to keep them in sync.

A scoped stylesheet applies to its Element and to the markup the Element's own template renders. Projected markup keeps the caller's styles, a nested card answers for itself, and a component can't restyle the page around it.

Cascade layers outrank specificity. Tailwind v4 puts utilities in `@layer utilities`, and an unlayered rule beats every layered one. The collection's `:where()` defaults were unlayered, so they beat the utilities they were meant to lose to.

Four alternatives were rejected.

- Shadow roots end light-DOM projection and document-level Tailwind, and both are invariants.
- `@scope (app-card) to (x-content)` alone also excludes markup the Element projects into a nested component.
- An ownership attribute alone, as in Angular's emulated encapsulation, lets `:host([flush]) .body` match the body of an unflushed card nested inside.
- One emitted `.css` file per Element would break the single-stylesheet artifact and the service worker precache.

## Decision

An Element opts in with `styles: true`, and its stylesheet is the module's sibling `.css` file.

- A template compiled for a styled Element stamps `data-ui-owner="<tag>"` on every element it renders. Authored markup may not write that attribute.
- `scopeStylesheet` in `@core/elements/style-scope.js` wraps the rules in `@layer components { @scope (<tag>) to (:scope <tag>) { … } }` and adds the owner stamp to each compound selector. `:host` becomes `:scope`. The function uses no DOM, so the browser, the build and the project model produce identical output.
- It refuses Tailwind directives, `@import`, `@layer`, document-global names such as `@keyframes`, and shadow-DOM selectors, and it names the offending line.
- Element styles sit in Tailwind's `components` layer, above preflight and below utilities. `style.css` declares Tailwind's layer order first and puts the collection defaults in the same layer.
- The `display: contents` defaults for `<x-content>` and `<x-route-outlet>` live in a layer that `element-defaults.js` prepends to `<head>`, so that layer sorts before Tailwind's.

| Path | What happens |
|---|---|
| Source | `defineComponent` fetches, scopes and adopts the sheet before `customElements.define` |
| Production | The build turns `styles: true` into a virtual CSS module and folds every chunk's rules into one stylesheet |
| Development edit | `reviseStylesheet` replaces the adopted sheet's rules in place |

`npm run verify` refuses a missing or unscopable stylesheet at its line and column.

## Consequences

- A utility class beats both collection defaults and Element rules.
- A styled Element costs one attribute per rendered element. Unstyled Elements cost nothing.
- An Element's own `:host` rule beats a parent's rule at equal specificity, because scope proximity is part of the cascade.
- Nodes created in JavaScript or written through a trusted HTML sink carry no stamp and get none of the rules.
- Two Elements in one module can't both have a stylesheet.
- An engine in the support matrix without `@scope`, or a stylesheet large enough to need per-route delivery, would reopen this.
