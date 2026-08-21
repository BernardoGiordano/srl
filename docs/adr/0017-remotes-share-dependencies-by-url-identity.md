# ADR-0017: Remotes share the shell's dependencies by URL identity

- Status: accepted
- Date: 2026-08-12
- Affects: `source/lib/core/remotes/mfe.js`, `app.manifest.json`, `index.html`

## Context

Two independently released artifacts on one page can each bring their own copy of `lit`
and their own `SignalElement`. When they do, an element defined by one is not the element
the other extends, and the shared collection stops being shared: two registries, two
reactive systems, and a class identity check that fails for reasons no stack trace
explains.

The alternative — per-remote dependency versions, which a bundler-based host would give
for free — means a remote's deployer chooses the framework version running in the shell's
realm, for every user, without the shell rebuilding.

## Decision

Module identity is URL identity: one `lit` URL, one instance. The page's import map
declares the shared specifiers, and a remote may use only its declared shared
bare-specifier interface. Locations and artifact-owned styles, templates and locales come
from `app.manifest.json`, fetched on every page load; module digests are governed by the
import map, and stylesheet and template digests travel with their asset records.

Production composition projects a verified remote artifact report into both documents
without putting the remote's implementation into the shell bundle.

## Consequences

A remote cannot upgrade the shell's framework version, and cannot pin an older one. That
is governance rather than a defect: a shared dependency version is a security boundary,
because the shared instance runs in the shell's realm with the shell's credentials in
reach.

The cost is coordination — a framework upgrade is a shell release plus a rebuild of every
remote that declared the specifier — which is the same cost the integrity pinning already
imposes and is checked by the same run.

Reopen if remotes ever run in a realm of their own, at which point sharing by URL is no
longer what makes them one application.
