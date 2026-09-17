# ADR-0120: One command runs every check

- Status: accepted
- Date: 2026-09-17
- Affects: `cli/checks/`, `cli/diagnostics/catalog.mjs`, `cli/project-model/`, `cli/language-server/service.mjs`, `cli/delivery/build.mjs`, `cli/bin/srl.mjs`, `tools/checks/verify-deps.mjs`

## Context

Verifying one change took five commands. `tsc --noEmit` printed text. `srl check templates`,
`srl check importmap` and `srl check messages` each printed `Diagnostic` values, as
ADR-0072 decided. `srl model` printed a count and kept its findings in a shape of its own,
with a `kind` in place of a code, absolute paths, and a `note` severity no other check used.
An agent had to run all five and parse three shapes.

Codes were too coarse to act on. `templates/dialect` covered 21 different refusals, so the
language server's `uses` quick fix matched the message text with a regular expression to
find the one refusal it could fix. Rewording that message would have broken the fix
without failing a test.

The READMEs said the build checks templates. The build read the project model and refused
its errors, and it never ran the template checker.

Three alternatives lost.

- An npm script that runs the five commands in a row keeps three output shapes and five
  process startups.
- Spawning `tsc` returns text. TypeScript is already a dependency of the CLI, so the
  compiler API gives diagnostics as values at no extra cost.
- One dialect code with a sub-kind field would add a field that only one check needs,
  which ADR-0072 says belongs in the code.

## Decision

**`srl check` is one runner.** `cli/checks/index.mjs` runs five subjects in one process,
`project`, `types`, `templates`, `importmap` and `messages`, and returns one `Diagnostic[]`
ordered by application. Naming subjects narrows the run. The runner reads each
application's project model once and hands it to every check that needs it.
`srl check <subject>` goes through the runner too, and each check module still runs by
path.

**The type check is `tsc` in process.** `cli/checks/type-check.mjs` builds one program from
the root `tsconfig.json` with that file's own options and reports `types/ts<number>`. It
does not share the template checker's program, because that program relaxes the
unused-name rules for generated code. Both checks read the configuration through
`cli/checks/tsconfig.mjs`.

**A code names one problem.** The template dialect reports 19 codes where it reported one.
The model's stylesheet finding splits into three codes. `readProject()` converts every model
finding into a `Diagnostic` with a `project/` code before returning it, and `note` becomes
`warning`, the severity ADR-0072 already defines for a finding that is reported and not
refused. The repository verifier reports model errors under those codes.

**The catalogue is code.** `cli/diagnostics/catalog.mjs` holds one sentence per code, and
`srl check --codes` prints it. A test fails when a check reports a code the catalogue lacks,
and when the catalogue holds a code no check reports.

**The build runs two subjects.** `buildArtifact()` and `buildRemoteArtifact()` run `project`
and `templates` through the runner and refuse on any error. Those two decide whether the
artifact's pages render correctly. The type check covers every file `tsconfig.json`
includes, suites and tools among them, and the build already resolves the import map on
its own terms.

**The editor keys on codes.** The `uses` quick fix answers `templates/missing-use`, and the
language server handles one diagnostic type.

## Consequences

- An agent's loop is to edit, run `srl check --json`, and read codes.
- `srl build` needs a `tsconfig.json` at the repository root, which `srl new` writes. A
  repository without one gets `templates/no-compiler` from the build.
- The editor shows model warnings as warnings. It used to show them as information.
- `srl model --json` diagnostics carry `code` in place of `kind`.
- `srl check` with no subject runs every check. It used to refuse.
- A full `srl check` over this repository takes about six seconds, with two compiler
  programs. If that grows, sharing parsed source files between the two programs comes
  first.
- Every expression refusal shares `templates/expression`, because the core expression
  parser throws plain errors. A code per refusal would need codes in the parser.
- Reopen this if a check needs a `Diagnostic` field beyond its code and message, or if one
  code starts to cover two problems.
