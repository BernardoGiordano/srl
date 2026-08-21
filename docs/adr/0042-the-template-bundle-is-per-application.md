# ADR-0042: The template bundle is per application and derived from the project model

- Status: accepted
- Date: 2026-08-12
- Affects: `tools/delivery/bundle-templates.mjs`

## Context

Collapsing every `.html` template into one `templates.json` turns N requests into one.
Twelve templates over HTTP/2 on a fast connection is not worth optimising; twelve over a
high-latency link, or a hundred in a real application, is.

Two things about the bundle are easy to get wrong. Its keys are the URLs the browser will
ask for, and those depend on where each file is *mounted* — a page's own template is
`/src/…`, a shared component's is `/components/…`. And which templates ship is a project
fact rather than a directory listing: this tool used to walk `src/`, `remotes/`, the
collection and the library and skip anything under a `test/` directory, while the
verifier's staleness check derived its own set. The two disagreed over
`source/lib/test/fixtures/*.html`, so enabling `templateBundle` would have failed the
build over a fixture the bundler was right to leave out.

## Decision

The bundle belongs to an application and is written into its directory. Only an
application knows both mounts, so a library-only bundle would have to guess one and would
be wrong the first time somebody changed it.

Which templates it contains comes from `tools/project-model/` (ADR-0038), which is the
same list the verifier's staleness check reads. Keys are built with the same mount table
the dev server and the deployment use, so a shared component's template is keyed
`/components/…` and not by its path on disk.

## Consequences

The step stays genuinely optional and behaviour-preserving. It compiles nothing — the
runtime compiler is the only compiler, in development and in production, over the same
bytes either way — so an absent `templates.json` means each `.html` is fetched
individually and the application behaves identically.

Re-running it after a template changes is required, and the verifier fails when the
committed bundle is stale, which is what stops the optional step from becoming a silent
source of old markup.
