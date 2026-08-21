# ADR-0008: Form values keep the control's own type, and convert at the service boundary

- Status: accepted
- Date: 2026-08-12
- Affects: `source/lib/core/forms/field.js`, application services

## Context

A DOM control gives back a string. A form that wants a number can convert on the way in,
per keystroke, or on the way out, once, where the request is built.

Converting early loses information that cannot be recovered: `Number('')` is `0`, so a
field the user left empty and a field the user deliberately set to zero become the same
value before any validator sees them. For a revenue field that is the difference between
"unknown" and "spent nothing", and the server is told the second.

## Decision

A field's value is whatever the control holds — usually a string, `string[]` for a
multi-select, a boolean for a checkbox. The type parameter follows the initial value and
the validators are typed against it. Conversion happens in the mapping function that
builds the request.

## Consequences

An empty field stays distinguishable from a zero for the whole life of the form, which is
what makes `required` and a range validator composable on the same field.

The cost is that every screen sending numbers writes a conversion line. That line is one
place per request rather than one place per keystroke, and it is where the payload's
shape is already visible.

This was the one friction the hand-wired version exposed that the forms layer kept
exactly as it found it.
