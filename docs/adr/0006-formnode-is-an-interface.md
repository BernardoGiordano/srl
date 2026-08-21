# ADR-0006: FormNode is an interface, not a base class

- Status: accepted
- Date: 2026-08-12
- Affects: `source/lib/core/forms/`

## Context

`FormField`, `FormGroup` and `FormArray` answer the same questions for a container that
holds them: is this valid, has it changed, may its errors be shown, may it be edited,
what did the server say. Angular's answer is `AbstractControl`, a base class the three
kinds extend.

The three classes here share no state and no constructor. A base class would exist only
to declare fourteen member names, and it would decide the inheritance of every form node
for a project that has no other use for it.

## Decision

The shared shape is `FormNode`, an interface in `@core/forms/types.js`, satisfied by three
unrelated classes through `@implements`. A container asks the contract's questions and
prefixes the answers with the member's name or index; it never checks which kind it is
holding.

The contract's half of each class is the untyped half — `snapshot` is `value.value`,
`fill` is `setValue` — because a parent reading a node it cannot name needs a signature
that does not mention the node's type parameter.

## Consequences

A member that drifts is a typecheck error rather than a container quietly skipping a
node, which is the property a base class would have given and the only one worth having.
A fourth kind of node costs nothing but answering the same questions.

The cost is duplication of the contract's members across three files, and no shared
implementation to inherit. Both were measured against the alternative when the repeating
row was built (ADR-0009) and neither grew.

Reopen if a fourth or fifth node kind appears and the untyped half turns out to be
identical in all of them — at which point a mixin, not a base class, is the shape to
compare against.
