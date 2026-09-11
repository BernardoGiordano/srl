# ADR-0110: The Lit adapter answers in Lit syntax

- Status: accepted
- Date: 2026-09-10
- Affects: `cli/language-server/authoring.mjs`, `cli/language-server/semantics.mjs`, `cli/language-server/service.mjs`, `cli/test/language-server.test.mjs`, `docs/known-gaps.md`

## Context

[ADR-0092](0092-one-semantic-snapshot-interprets-an-editing-template.md) built one
semantic snapshot for external srl templates and ruled that inline Lit markup is a
different authored form needing its own adapter. That adapter shipped answering exactly
one question: which tag is at this offset. It bought rename and references across both
forms, and nothing else.

Everything past tag identity was silence. Hovering `.range` in
`html\`<ui-date-range .range=${current}>\`` said nothing, though the project model knows
`UiDateRange.range` is a property and where it is declared. Completion inside the opening
tag offered nothing, though the same model drives a full binding list in a template file.
The tagged template got no semantic tokens, so a JavaScript grammar painted tag names,
bindings and text as one undifferentiated string. And a tag named there was invisible to
the `uses` rule, even though markup built in JavaScript needs `uses` exactly as markup in
a template file does — `ui-dynamic-filter.js` carries a hand-written comment saying so,
which is what a missing check looks like from the inside.

The rejected alternative was to read inline Lit as srl markup and reuse the srl answers
directly. It offers `[.row-key]`, `*for` and `(click)` where none of them render, and it
is the mistake ADR-0092 already refused.

The second rejected alternative was a separate Lit scanner. Element nesting, tag spans
and attribute spans are HTML in both forms, and a second scanner would have to tolerate
incomplete source, own its own ranges, and drift from the first one.

## Decision

Both authored forms read the same scan, and the dialect decides what else it means.

`scanTemplate` takes a dialect. srl records `{{ }}` and directive expressions and
lowercases attribute names, which is right for a form whose property bindings are written
in kebab case. Lit records no expressions and keeps attribute names verbatim, because
`.optionRenderer` names the property itself. `TemplateSemantics` then serves both:
`at`, `tags`, `attributeSpans` and `addUse` are structural, and member completion falls
out for Lit on its own, because its `at` never reports an expression.

A substitution is padded rather than blanked. Blanking `${rows}` to spaces left the
scanner reading the next attribute name as the unquoted value of `.rows=`, so `${…}`
becomes `$` padding of its own length — every span keeps its module offset, and an offset
inside the substitution reports the binding that owns it.

The binding surface moves behind the view. `attributeCompletions`, `attributeHover` and
`boundProperty` are adapter methods rather than functions a feature calls, so completion,
hover and definition ask the document's own form and no feature decides a dialect for
itself. srl writes `[.row-key]="expr"`; Lit writes `.rowKey=${expr}`, `@click=${…}` and
`?disabled=${…}` for the same property, event and attribute of the same element. Lit
offers no `*if`, `*for` or `*fragment`, because it has none.

Semantic tokens colour Lit tag names and binding prefixes and nothing else, because a
JavaScript grammar already paints the template literal and repainting attribute names and
text would fight it rather than add to it.

The `uses` rule reaches inline markup. A `defineComponent` module whose Lit template names
a project element absent from its `uses` gets a `templates/dialect` diagnostic worded as
the checker words it, so the existing quick fix answers both forms. Two limits are part of
the decision: a bare `customElements.define` is exempt, having no list for an entry to be
missing from, and a tag the project model has never seen is not reported, because it may
belong to a library `uses` does not govern.

What the adapter deliberately does not answer is the inside of a substitution. That is the
module's own JavaScript, and TypeScript already completes, types and navigates it. A
second list over a correct one is worse than none. For the same reason a module's outline
stays the JavaScript service's declaration list rather than an element tree.

## Consequences

Tag completion, binding completion, binding hover, property definition and semantic tokens
work inside `html` and `svg` templates, against the same Element model that drives them in
a template file. A component that writes markup in both forms gets one answer about its
elements and two syntaxes for writing them.

Adding a dialect is now one adapter and one scan flag. Adding an editor feature is one
question asked of the view, and it works in both forms or is explicitly declined by one.

The new diagnostic reports nothing on this repository today, which is the check agreeing
with the comment in `ui-dynamic-filter.js` rather than evidence it never fires — the tests
build the failing module directly.

`membersAt` stays srl-only, so a Lit template's substitution has no loop locals, no signal
unwrapping and no typed `$event`. Those are srl grammar; Lit writes the same things as
ordinary JavaScript, which is typed already.

Reopen this if inline Lit becomes the primary authoring form, which would make the
substitution worth typing against template scope rather than leaving to TypeScript, or if
lexical template fragments remove the reason to write cell markup in JavaScript at all —
in which case the question is whether this adapter still has a workflow to serve.
