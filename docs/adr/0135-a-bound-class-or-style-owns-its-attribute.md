# ADR-0135: A bound class or style owns its attribute

- Status: accepted
- Date: 2026-10-09
- Affects: `source/lib/core/template/dialect.js`, `source/lib/core/template/template.js`, `cli/checks/template-check.mjs`

## Context

An application ported from Angular writes `[class.active]="on"`, `[style.width.%]="share"`
and `class="base" [class]="tone"` on the same element. The dialect read none of these.
`[class.active]` set a literal attribute named `class.active`, `[style.width.%]` did the
same, and `[class]` replaced the static `class` beside it, because lit binds one value per
attribute name and the later binding won. Nothing reported any of it. A port of a real
application had about sixty such bindings, and each failed as a missing style.

Angular's `[attr.aria-label]` failed the same way, as an attribute named `attr.aria-label`.
The dialect already sets attributes with `[aria-label]`, so the prefix adds nothing.

Three alternatives lost.

**Refuse the Angular spellings.** Every port rewrites sixty bindings into
`class="{{ … }}"` strings, which hide the per-class condition in a ternary and give the
checker nothing to read.

**lit's `classMap` and `styleMap` directives.** They patch `classList` and `style` and
leave other classes alone. They need two more bare specifiers, so every import map, the
scaffold and the build's pin table change, and `styleMap` writes properties without
passing the style sanitizer.

**One binding per class through `classList.toggle`.** It needs a directive per class and
an order between them and a `[class]` that replaces the attribute.

## Decision

The compiler joins every source of `class` on one element into one attribute binding, and
every source of `style` into another.

- `[class.name]` adds `name` while its value is truthy. The name is everything after
  `class.`, so `[class.py-1.5]` works. The HTML parser lowercases it.
- `[class]` takes a string, an array of strings, or an object whose truthy keys are added.
- `[style.property]` and `[style.property.unit]` write one declaration. Null, undefined,
  false and the empty string leave it out. A value containing `;`, `{` or `}` is dropped,
  so a value cannot start a second declaration.
- Each dynamic style source passes the style sanitizer on its own, so a refused one drops
  only itself.
- The static `class` and `style` come first, then the bound sources in the order written.
- An element with no dynamic source keeps a static attribute.
- `[attr.name]` is refused with a hint to write `[name]`. `templates/refused-binding`.

## Consequences

- The bound attribute is rewritten whole on every change. A class that code adds to the
  element through `classList` disappears at the next update, so an element whose classes
  are bound must not be styled from script.
- `[class.name]` cannot name a class containing `/`, because the HTML parser ends an
  attribute name there. Write such a class through `[class]`.
- The checker types `[style.property]` as a string or number. `[class.name]` takes any
  value.
- Reopen this if an application needs script and a binding to share one element's classes.
