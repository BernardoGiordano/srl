# ADR-0038: One project model, parsed from an AST, that refuses to guess

- Status: accepted
- Date: 2026-08-12
- Affects: `cli/project-model/`, `cli/checks/`, `tools/checks/`

## Context

Three tools once worked out which components exist, each in its own way. The template checker walked a TypeScript AST, the verifier used a line-anchored regular expression and the template bundler globbed directories. The regex missed indented definitions, `void defineComponent(` and multi-line specs, and it matched text inside error messages. The tools agreed only because every definition happened to be written one way.

## Decision

`cli/project-model/` parses the TypeScript AST, and every tool reads the result. It owns custom element identity, template ownership, `uses` relationships and template globals. Applications and mounts come from `cli/layout.mjs` (ADR-0033).

A declaration with a computed tag, class or template is reported as `dynamic`, and the verifier fails the build. It might work in the browser, but no tool can see it, and a checker that silently knows fewer elements than the page defines teaches people to ignore it.

The model leaves out routes, injection tokens and remote grants, since each would have a single consumer.

## Consequences

- `--json` gives an editor or an agent the same answer the build uses.
- Parses are cached by path, size and mtime, so a process parses each file once.
