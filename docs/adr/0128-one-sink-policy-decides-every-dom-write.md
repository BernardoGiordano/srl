# ADR-0128: One sink policy decides every DOM write

- Status: accepted
- Date: 2026-10-06
- Affects: `source/lib/core/template/dialect.js`, `source/lib/core/template/security.js`, `source/lib/core/template/template.js`, `source/lib/core/template/expression.js`, `source/lib/core/elements/mount.js`, `cli/checks/template-check.mjs`

## Context

A security review found four places where a value reached a DOM sink that no sanitizer
chose.

Lit reads attribute names a second time. A leading `.`, `?` or `@` makes it bind a
property, a boolean or an event, and a `$lit$` suffix or a quote changes which value
lands where. The dialect classified `.srcdoc="{{ x }}"` as a plain attribute, so lit set
`iframe.srcdoc` with no sanitizer and the checker stayed silent. A binding inside
`<style>` wrote CSS for the whole page, and one inside `<xmp>` left lit without a marker,
so every later value moved onto the next binding.

The HTML sanitizer read `children` and `attributes` from the elements it cleaned. A
`<form>` exposes its controls by name, so two inputs named `children` hid the form's
real children from the walk.

An assignment in an event binding, such as `(click)="innerHTML = x"`, and an outlet's
props wrote properties directly. Both Trusted Types policies returned their input, so
enforcement could not catch a path that skipped the sanitizer.

Vendoring DOMPurify, as ADR-0032 allows, would also fix the walk. It lost because the
fault was how the walk reads the DOM, which a small change fixes, and a second
sanitizer with its own allowlist would drift from the dialect's sink table. Sanitizing
framework template source in the compiler's policy lost too, because it would strip the
bindings the compiler needs.

## Decision

`dialect.js` classifies and `security.js` sanitizes. The runtime compiler, the template
checker and every runtime property write ask the same functions, so they refuse the same
things.

- A name lit reads as its own syntax is `reserved-name`, in attributes, binding targets
  and event names.
- A template may not contain `<script>`, `<base>`, `<link>` or `<meta>`.
- A raw-text element takes no `{{ }}` and no content property binding. `<textarea>` and
  `<title>` are not on that list, because lit binds their content as text.
- A static `srcdoc` or `innerhtml` attribute is refused. It has to be bound.
- `assignProperty` writes event-binding assignments and outlet props through the sink a
  property binding to the same element would use. Event properties stay writable there,
  because a string written to one is inert and a function is component code.

The sanitizer walks with a `NodeIterator` and calls getters and methods taken from
`Element.prototype` and `Node.prototype`, never from the element. It drops forms and
form controls, prefixes `id` and `name` with `user-content-`, and removes `position`
and `z-index` from inline styles.

The `ui-test` policy's `createHTML` runs the sanitizer. It returns markup unchanged only
for the sanitizer's own parse and for a reviewed `bypassSecurityTrust*` value. The
compiler's `ui-test-template` policy still returns its input, because its only sink is
the inert template the compiler walks.

## Consequences

- A fragment link or a `<label for>` inside sanitized markup must name the prefixed id,
  such as `href="#user-content-terms"`.
- Sanitized markup can't hold a form. An application that needs one renders it from a
  template.
- A prop named like a URL attribute, such as `data` or `src`, takes a string at runtime,
  as a `[.data]` binding already required.
- The HTML Sanitizer API, once every supported engine ships `setHTML`, would reopen the
  choice of walker.
