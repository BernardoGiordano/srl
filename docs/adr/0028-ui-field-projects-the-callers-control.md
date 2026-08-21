# ADR-0028: `ui-field` projects the caller's control rather than rendering one

- Status: accepted
- Date: 2026-08-12
- Affects: `source/components/inputs/ui-field.js`

## Context

A field wrapper can either render the control itself, configured through properties, or
accept the control as projected content and wire it.

Rendering it means a property for every attribute an input has — `type`, `autocomplete`,
`min`, `step`, `inputmode`, `placeholder`, `rows` — and still missing the twentieth the
day someone needs it. Every one of those properties is a name the caller has to learn for
something they already know how to write in HTML.

## Decision

The control is projected. The caller writes the element they already know, `ui-field`
wires it, and Tailwind reaches it because everything here is light DOM.

Two kinds are understood: a native `<input>`, `<textarea>` or `<select>`, which needs
nothing because `value`, `input`, `blur` and `<label for>` are already the contract; and
anything implementing `FormControl` (ADR-0011).

Because the control is a node this element did not render, the wiring is an `effect` and
two listeners rather than template bindings. That wiring is idempotent and re-runs after
every update, since a control behind an `*if` in the caller's markup is a different
element after it comes back.

Disabled state is not an attribute on this element. It lives on the `FormField`, because
the questions that decide it — is the form saving, may this user edit this — are answered
where the form is (ADR-0007), and a second copy on the element would be a second copy to
keep in step.

## Consequences

The screen writes the control and the label, and gets the ARIA wiring, the error paragraph
and the disabled propagation for free.

Error *text* is resolved here from a code the field carries. The collection's own
validator codes come from standard text under `ui.field.*`; codes an application's server
invents come in through `messages`. Neither path ships prose from the component's own
file, which is what keeps the collection translatable without configuration.
