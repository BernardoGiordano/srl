# ADR-0074: The artifact report is a named shape, written and read in one place

- Status: accepted
- Date: 2026-08-27
- Affects: `cli/delivery/artifact-report.mjs`, `cli/delivery/build.mjs`, `cli/delivery/release.mjs`, `cli/delivery/remote-release.mjs`, `cli/delivery/verify-http.mjs`, `tools/benchmark/run.mjs`

## Context

`artifact.json` is the central value of the delivery pipeline. `srl build` writes it
beside the bytes; a release is prepared from it, a live origin is verified against it, a
composition recomposes one from another, and the benchmark measures what it describes.
Six tools, one document.

It was declared `Promise<Readonly<Record<string, unknown>>>`, which is to say it was not
declared. Three consequences followed.

The build re-read its own output. `cli/delivery/build.mjs` carried five helpers —
`recordValue`, `arrayValue`, `stringValue`, `stringArray`, `artifactRecord` — whose only
purpose was to poke at an object the same file had just constructed, because the type it
returned said nothing about what was in it. `composeArtifact` then parsed a report the
build had written and re-derived its shape by hand.

Every consumer re-checked it differently. `release.mjs` had `parseArtifact`,
`remote-release.mjs` had `parseRemoteArtifact`, and `verify-http.mjs` and
`tools/benchmark/run.mjs` each opened with their own `report.version !== 1 || …`
expression. Four hand-rolled validations, no two covering the same fields: the benchmark
checked `totals` and nothing else did, the release checked that the CSP admits the import
map and nothing else did, and a report that passed one could fail another for reasons
neither stated.

And nothing could be tested without a build. The only way to assert what the pipeline
does with a malformed report was to produce one, which meant running Vite over a real
application and corrupting the output.

## Decision

`cli/delivery/artifact-report.mjs` owns the shape. `writeReport` is the only thing that
writes one and `readReport` the only thing that reads one; `parseReport` is the pure
middle — bytes in, `ArtifactReport` out — and it is what makes the contract assertable
in a suite that never starts a bundler.

The type is a discriminated union. A shell report carries `shared`, `remotes` and
`security`; a Remote report carries `kind: 'remote'`, its `name`, its publication `base`
and its transport descriptor. `isRemoteReport` is the narrowing, and `RemoteTransport` is
`Omit<RemoteDescriptor, 'mount' | 'requires' | 'grants'>` — the runtime's own declaration
minus the three fields that are the shell's business, rather than a second copy of it.

Admission happens on the way in *and* on the way out. `writeReport` validates before the
bytes reach disk, so a build cannot publish a report its own readers would reject, and
the internal consistency of the document — a CSP that admits the import map hash it was
generated for, a `templates.count` that matches the file list, an inventory that does not
list `artifact.json` itself — is checked once, here, instead of partially, six times.

What is *not* here is release policy. A build may legitimately produce an artifact with
no commit behind it; a release may not ship one. So `release.commit` is `string | null` in
the shape, and the requirement that it be a full 40-character commit lives in
`release.mjs` and `remote-release.mjs`, next to the `--experimental` gate and the
publication-layout rule that reads a version out of a Remote's base.

The rejected alternative was a `types.d.ts` beside the writers, declaring the shape
without owning it. That is where `release.mjs` already was: it had an `Artifact` typedef,
and it still hand-parsed the document, because a declaration nothing enforces is a comment.
The reason to move the reading and writing rather than only the type is that the type
alone was tried and did not hold.

## Consequences

Adding a field to the report is one edit. Every consumer sees it as a typed property, and
the six casts that used to stand in for the declaration are gone —
`cli/test/artifact.test.mjs` asserted on `shell.remotes` through a hand-written structural
type, and now asserts on it directly.

The pipeline is inside the typecheck for the first time. `verifyPayload` returns the
inventory it admitted, so the cache-class narrowing happens at the check that performs it
rather than at every use of the result.

Error messages changed. `release:artifact: artifact.json has an unsupported release
contract.` was one sentence for eleven different failures; refusals now name the field
and the file. Nothing asserted on the old strings, and a deploy log that used to say only
that something was wrong now says what.

The reverse pull is a report that grows a field one tool wants. Six consumers share this
declaration, and a field only the benchmark reads belongs to the benchmark. If
`ArtifactReport` starts carrying per-consumer fields, or if `parseReport` grows an
`options` argument so that one caller can relax a rule, the deepening has failed and this
record should be reopened.

This does not touch `release.json`. The retained release report is a different document
with a different writer — `release.mjs` and `remote-release.mjs` — and `verify-release.mjs`
still admits it by hand. Naming that one is the same move again, and it is worth doing
separately rather than folding two shapes into one module because they happen to be
adjacent.
