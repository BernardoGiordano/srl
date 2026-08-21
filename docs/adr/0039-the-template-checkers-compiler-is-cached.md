# ADR-0039: The template checker keeps one compiler per process

- Status: accepted
- Date: 2026-08-12
- Affects: `tools/checks/template-check.mjs`

## Context

A template is checked by compiling a shim: a virtual file inside the ordinary program. To
check it, TypeScript needs the whole repository plus `lib.d.ts`, and building that from
scratch costs about 2.5 seconds.

`checkTemplateSource` is called once per template by the CLI and once per case by its own
tests. Paying the full price per call meant twenty-six seconds for one test file whose
assertions are one-line templates.

## Decision

The compiler is built once per process and three things are reused, in increasing order of
payoff: the parsed tsconfig, the parsed source files, and the previous program's structure
through `oldProgram`. The only file that changes between calls is the shim, so TypeScript
re-checks that file and keeps everything else.

The source-file cache is keyed by modified time, so a file edited on disk between two
calls is re-read.

## Consequences

The mtime key matters more for the editor seam than for the CLI. A long-lived process
answering from a stale parse would report errors about code that no longer exists, which
is worse than being slow.

`checkTemplateSource()` stays the in-memory entry point an editor integration would call.
Interactive completion and inline diagnostics do not exist; the trigger for building them
is an editor extension, or an agent workflow that wants diagnostics before saving.
