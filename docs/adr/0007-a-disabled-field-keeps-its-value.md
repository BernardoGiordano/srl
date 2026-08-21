# ADR-0007: A disabled field keeps its value in the form's payload

- Status: accepted
- Date: 2026-08-12
- Affects: `source/lib/core/forms/field.js`, `source/lib/core/forms/group.js`

## Context

A disabled field stops being answerable for: its validators do not run, it reports valid,
and it shows no error. That is Angular's behaviour and it is the useful half — a rule the
user cannot reach and cannot fix must not be what refuses a submit.

Angular also drops a disabled control's value out of `group.value`. Copying that means a
form that disables a field for a read-only user quietly turns its `PUT` into a partial
one, and the server writes the column back to nothing. The failure is silent, it is in
the payload rather than in the screen, and the screen looks correct while it happens.

## Decision

Disabling changes what is *asked* of a field, not what the form holds. `group.values`
still contains a disabled field's value, and `dirty` still counts it — the value is going
to be sent, so it is still an unsaved change, and an unsaved-changes guard that forgot
about it would let the user walk away from one.

A payload that really must omit a field omits it in the mapping function that builds the
request, where the omission is a visible line of code.

## Consequences

`setDisabled()` becomes usable as a *mode* switch: `customer-detail-page` renders read
and edit from one component and one set of fields, and the whole difference is a call to
it. A form switched off while a save is in flight keeps everything it was going to send.

The cost is a documented divergence from Angular that will surprise someone who expects
`value` to skip disabled controls. That is the trade taken deliberately: the surprise is
loud and one-time, and the alternative's failure is silent and per-request.
