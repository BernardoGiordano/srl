# ADR-0038: One project model, parsed from an AST, that refuses to guess

- Status: accepted
- Date: 2026-08-12
- Affects: `tools/project-model/`, `tools/checks/`

## Context

Three tools answered the same questions separately. The template checker walked a
TypeScript AST, the verifier matched a line-anchored regular expression, and the template
bundler globbed directories and had no idea what a definition was.

Their answers agreed only by luck. The regex — `/^await defineComponent\(\{...\}\);$/gm` —
cannot see a definition indented inside a block, one spelled `void defineComponent(`, or a
`template` key on a continuation line, and cannot tell a real call from the same text
inside an error message. It agreed with the checker only because every definition in this
repository happened to be written the one way the pattern matched. The bundler and the
verifier openly disagreed about whether a test fixture's markup is an application
template, visibly enough that enabling `templateBundle` would have failed verification
over a fixture the bundler deliberately left out.

## Decision

One model, in `tools/project-model/`, parsed from the TypeScript AST and consumed by every
tool that needs to know what exists. It owns custom-element identity, template ownership,
`uses` relationships and template globals. Applications and their mounts come from
`tools/layout.mjs` (ADR-0033), which this module consumes rather than re-deriving.

A declaration whose tag, class or template is computed is reported as `dynamic` rather
than skipped. It may well work in the browser; the point is that no tool here can see it,
so the model says so and the verifier fails the build. A checker that quietly knows about
fewer elements than the page defines produces exactly the errors that teach people to stop
trusting it.

The model deliberately does not cover routes, injection tokens, remote grants or message
keys. Custom-element and template identity is the fact three consumers already needed; the
rest would be a model with one consumer, which is a data structure looking for a reason.

## Consequences

`--json` gives an editor or an agent the same answer the build uses, and `--element` gives
one element and its dependencies. That was not the motivation, but it is the part that
keeps paying.

Parsing is cached by path, size and mtime, so a process that reads one file twice parses
it once — TypeScript's parse of a 1,300-line component is the expensive part, not the disk
read.
