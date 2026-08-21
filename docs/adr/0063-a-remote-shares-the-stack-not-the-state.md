# ADR-0063: A remote shares the stack, never the shell's state

- Status: accepted
- Date: 2026-08-12
- Affects: `example/remotes/billing/`, `example/remotes/analytics/`

## Context

Because a remote runs on the shell's origin with the shell's import map, its modules
resolve. Importing `currentPath` and `navigate` from the shell's router would work.

It would be wrong twice over. The mount path would then be written in the remote as well
as in `app.manifest.json`, and the two could drift. And a capability the shell handed over
would be bypassed in favour of a module-level global that no `revoke()` can take back
(ADR-0016).

## Decision

A remote shares the *stack* — Lit, the signals library, the template compiler, the i18n
module, and elements from `source/components` — and none of the shell's state. Everything
stateful arrives through `mount(host)`.

Sub-view routing stays the remote's own business. The shell's route table knows nothing of
`/invoices` or `/plans`, which is what lets the remote add or rename a sub-view with no
shell change, and the prefix those views hang off comes from `host.mount`.

## Consequences

A remote using the shell's component collection is worth demonstrating and costs nothing:
the collection imports nothing from an application, so it works in a remote exactly as it
does in `src/`, and the remote's table has the same sorting, column chooser and accessible
names as the shell's own.

The two example remotes deliberately differ. Billing shares the stack and is granted no API
access, because it needs none. Analytics shares no dependency with the shell at all and
does call a server, with grants naming exactly which paths it may reach — between them they
show both ends of what the contract allows.
