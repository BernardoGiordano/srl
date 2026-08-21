# ADR-0011: FormControl is a duck-typed contract, not a base class

- Status: accepted
- Date: 2026-08-12
- Affects: `source/components/inputs/form-control.js`, `source/components/inputs/ui-field.js`

## Context

A native `<input>`, `<textarea>` or `<select>` already satisfies everything `ui-field`
needs: `value`, an `input` event, a `blur` event, an assignable `id`, and attributes that
mean something.

The other case is a custom element whose value is not a string, whose focusable node is
generated inside it, and whose change event has a name of its own. `ui-combobox` is
exactly that, and it caused four separate frictions for the screen that had to wire it by
hand: a value that had to be mapped both ways, a `<label for>` that could not
reach the focusable node, an `aria-describedby` with nowhere to point, and a "focus the
first invalid field" that needed a special case.

A base class would decide a component's inheritance in exchange for seven members, and
this collection's elements already extend `SignalElement`. A mixin would work, but it puts
the contract somewhere harder to read than a list of seven names.

## Decision

An element implements `FormControl` by having the members, not by extending anything.
`isFormControl` is the whole of the runtime check.

The four wiring members — `focusControl`, `setInvalid`, `setDescribedBy`, `setLabelledBy`,
`setDisabled` — are methods rather than properties, because the element usually has to
forward them to a node it renders rather than to itself, and a property that has to be
forwarded anyway is a property plus a `willUpdate`.

## Consequences

`ui-combobox` became usable as a form field without changing its inheritance, and an
application's own element can join by implementing seven names.

`setDisabled` being the element's job rather than `ui-field`'s is the load-bearing part: a
native control has one attribute, an element that renders its own input and its own chips
has to switch off each of them, and only the element knows what "each of them" is.

The cost is that nothing enforces the contract at compile time beyond `@implements`, and a
missing method surfaces as a runtime check rather than a type error at the call site.
