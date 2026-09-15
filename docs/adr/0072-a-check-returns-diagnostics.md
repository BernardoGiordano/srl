# ADR-0072: A check returns diagnostics and prints nothing

- Status: accepted
- Date: 2026-08-26
- Affects: `cli/diagnostics/`, `cli/checks/`, `tools/checks/`

## Context

Each check used to print its findings as it found them and return a count or an exit code. A test could assert how many things were wrong and not which ones. An editor or an agent had nothing to read. Every check also carried its own copy of the report format and the exit-code rule.

## Decision

`cli/diagnostics/types.d.ts` declares a finding as a value.

```
{ severity, code, message, group, file, line, column }
```

- `severity` is `error` (fails the run), `warning` (reported only) or `info` (a check that passed).
- `code` is a stable, namespaced id such as `deps/undeclared-specifier`, so tests and filters survive a reworded message.

Every check returns `Diagnostic[]` and prints nothing. `cli/diagnostics/index.mjs` is the only formatter, and it has two outputs. The terminal report sends progress to stdout and refusals to stderr, and `--json` prints one document. Every check gets `--json` without implementing it.

## Consequences

- Tests assert on codes.
- The language server reports the same findings the command line does.
- A field that only one check needs belongs in that check's `code` and `message`. If `Diagnostic` starts growing per-check fields, reopen this.
