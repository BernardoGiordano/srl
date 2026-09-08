# ADR-0092: One semantic snapshot interprets an editing template

- Status: accepted
- Date: 2026-09-08
- Affects: `cli/language-server/semantics.mjs`, `cli/language-server/service.mjs`, `cli/checks/template-check.mjs`

## Context

Each language feature interpreted template source for itself. Completion searched
backwards for an opening angle bracket, hover tokenized a word, loop completion scanned
every preceding `*for`, and rename matched tag-shaped text across the whole file. Those
answers disagreed as soon as source contained an opposite quote inside an attribute, a
comparison inside an interpolation, a loop that had already ended, a comment, or raw
script text.

Expression completion also stopped at the host class surface. After `rows.` it offered
the host's other names instead of array members; after `$event.` it did the same instead
of using the event type the checker already emitted. The static checker knew both types,
but the editor rebuilt neither of them accurately.

The rejected alternative was another set of feature-specific regular expressions. It
would repair individual examples while leaving every new feature responsible for HTML
state, template scope, and source ranges again.

## Decision

`semantics.mjs` constructs one tolerant semantic snapshot from the current template
text. It owns actual tag spans, opening-tag and attribute context, expression ranges,
element nesting, loop lifetime, event scope, and structural `uses` edits. Completion,
hover, definition, references, rename, semantic tokens, links, outlines, and quick fixes
all ask that snapshot what the current offset means.

The snapshot is deliberately tolerant because its input is text between keystrokes. A
bare `<` is a tag prefix, an unclosed quoted binding remains an expression, and an
unclosed element owns its children through the end of the current source. Comments and
raw `script` or `style` content contain no template tags.

TypeScript remains the authority for expression types. Member completion emits the same
host access, signal unwrapping, loop item types, template globals, and typed DOM event
shape as the checker, then asks the checker's cached compiler for the resulting
properties. Diagnostics and completion therefore share compiler state and overlay reuse
instead of building a second type model.

Tag rename may start at either a template tag or the JavaScript registration literal.
It edits only parsed template tag spans plus that declaration, and refuses a new tag
already present in the project model. A `uses` quick fix replaces the parsed array
expression structurally, so a trailing comma cannot become an omitted array entry.

This decision covers external srl templates. JavaScript `html` tagged templates are a
different authored form with Lit binding syntax; treating them as srl markup would undo
the locality gained here. Embedded Lit analysis needs its own adapter over shared Element
identity.

## Consequences

Bare tag completion, nested host members, typed event members, scoped loop locals, native
input bindings, declaration-start tag rename, and valid trailing-comma quick fixes are
observable through the existing language-service interface. Tests apply returned edits
to complete source and inspect the resulting syntax rather than asserting isolated edit
fragments.

The editor scanner and the checker remain two implementations over the runtime dialect
seam: one tolerates incomplete text and returns context, while one emits TypeScript and
returns diagnostics. Directive and expression grammar still comes from the runtime's
shared dialect and expression parser.

The first compiler-backed member request pays normal TypeScript program warmup. A member
answer is cached across suffixes typed after the same dot and invalidated by project-model
or open-JavaScript changes; a new target reuses the program under ADR-0091's overlay rule
and adds only a new generated query root.

Reopen this decision if the runtime adopts a standards-based parser that can preserve
incomplete source ranges and scope, or if TypeScript exposes a completion interface that
can consume template expressions directly without a generated query root.
