# ADR-0017: Remotes share dependencies by URL identity

- Status: accepted
- Date: 2026-08-12
- Affects: `source/lib/core/remotes/mfe.js`, `app.manifest.json`, `index.html`

## Context

Two artifacts on one page can each bring their own `lit` and `SignalElement`. When they do, an element defined by one isn't the class the other extends. The page ends up with two registries, two reactive systems and identity checks that fail without a useful stack trace.

Bundler-based hosts often allow per-remote dependency versions. Here that would let a remote's deployer choose the framework version running in the shell's realm.

## Decision

Module identity is URL identity, so one `lit` URL means one instance. The page's import map declares the shared specifiers, and a remote may only use those. The manifest supplies locations and each artifact's styles, templates and locales. The import map pins module digests, and asset records carry stylesheet and template digests.

## Consequences

- A remote can't upgrade or pin the shell's framework version. The shared instance runs with the shell's credentials in reach, so the version is a security decision.
- A framework upgrade means a shell release plus a rebuild of every remote that uses the specifier.
- Remotes running in a realm of their own would reopen this.
