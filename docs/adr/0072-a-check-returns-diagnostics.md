# ADR-0072: A check returns diagnostics, and prints nothing

- Status: accepted
- Date: 2026-08-26
- Affects: `cli/diagnostics/`, `cli/checks/`, `tools/checks/`

## Context

Static verification with no build step is what this toolchain is for. Six checks do it —
the dependency and layering verifier, the import-map check, the template checker, the
packaged-install probe, the generated-documentation check and the decision-record check —
and every one of them used to report what it found by writing to a terminal at the point
of discovery. `console.error` there, and a number as the return value: a count of
problems, or a process exit code.

The count crossed the function boundary. The finding did not, and three things followed
from that.

A suite could assert that six things were wrong and not which six. `tools/checks/verify-deps.mjs`
was 1357 lines with no exports at all, so its behaviour was untestable except by running
the process and matching its output; the three tool modules that did have a parameter seam
— `readProject`, `readRecords`, `checkReadme` — were exactly the three with real test
suites, which is not a coincidence.

Nothing but a terminal could read a result. An editor has no line to underline and an
agent has no field to branch on, so the gap recorded in
[`docs/known-gaps.md`](../known-gaps.md) — inline diagnostics, an agent workflow that
wants them before saving — could not be closed by anything short of rewriting a check.
`checkTemplateSource()` was already the in-memory seam for one of the six
([ADR-0039](0039-the-template-checkers-compiler-is-cached.md)), and it answered with
`string[]`: a message with the file, line and column formatted into it.

And the wording of a report was copied. Each check grew its own `show()` for spelling a
path, its own `fail()`, its own `  ok  ` / `  note ` / `  FAIL ` prefixes, its own
`N problem(s):` block and its own exit-code rule. Six copies of one decision, drifting.

## Decision

A finding is a value. `cli/diagnostics/types.d.ts` declares it:

```
{ severity, code, message, group, file, line, column }
```

`severity` is `error` (a refusal, and the exit code), `warning` (reported, does not fail)
or `info` (a check that ran and passed). `code` is a stable namespaced identifier —
`deps/undeclared-specifier`, `templates/ts2339` — so a test, a filter or a suppression
names something that does not change when the sentence does.

Every check returns `Diagnostic[]` and prints nothing. `cli/diagnostics/index.mjs` is the
only module that formats one, and it has two adapters: the terminal report, which keeps
progress on stdout and refusals on stderr, and one JSON document. `--json` is therefore a
flag every check has and none of them implements.

A passing check is a diagnostic too. "The import map carries the library fragment
verbatim" is a fact a caller should be able to assert without parsing a line of terminal
output, and it is the same value as a failure with a different severity.

## Consequences

The interface is the test surface. `verifyDependencies()` is now a function returning a
list, so a suite asserts on codes; `readRecords()` reports every malformed record instead
of throwing at the first, which is a behaviour change in the direction of one run per
problem set rather than one run per problem.

The reverse pull is real: a check that wants a shape only its own report needs will be
tempted to add a field here. Six consumers share this declaration, so a field that only
one of them sets belongs in that check's `code` and `message`, not in the type. If
`Diagnostic` grows a field per check, the deepening has failed and this record should be
reopened.

An adapter is what makes the seam real rather than a promise, and there are two the day
this lands. A third — a language server speaking LSP over `checkTemplateSource()` — is
what the known-gaps entry is now waiting on, and it needs no change to any check.
