# ADR-0094: An editor session owns what it started

- Status: accepted
- Date: 2026-09-08
- Affects: `editors/vscode/`, `editors/webstorm/`, `cli/language-server/server.mjs`

## Context

ADR-0090 made the editor plugins thin launchers, and they launch correctly: a project's
own server starts, one per root in VS Code and project-wide in WebStorm. What neither
adapter owned was everything else a running session drags along.

The VS Code adapter created a file watcher next to each client and disposed it only when
the client failed to start, so a normal stop, a removed folder or a restart left the
watcher running. The server separately registered its own watchers over global globs, so
a project was watched twice and, in a multi-root window, every root reloaded for every
other root's edit. Restart stopped and started through two maps with no ordering between
them, so a restart issued while a start was still in flight could leave a window believing
a stopped session was running.

Settings were advertised rather than wired. The client id was `srl-<folder index>`, and a
language client reads its trace level from `<id>.trace.server`, so the contributed
`srl.trace.server` reached nothing. `srl.nodePath` was read when a server was spawned and
never again. A folder with no toolchain returned silently, which is right for a folder
that is not an srl project and wrong for one whose `package.json` asks for `@srljs/cli`.

Capability negotiation was one-directional in the same way. The server registered watchers
without asking whether the client takes registrations, and answered an unimplemented
method with `null` rather than `MethodNotFound`, because the check read `params.id` and a
request carries its id on the message. WebStorm shipped no snippets, though snippets are
declarative editor resources under ADR-0090 and VS Code contributes six. Its minimum
build, 261, is a release where the platform's LSP rename does not exist yet.

## Decision

An editor session is a named thing that owns its own lifetime. `editors/vscode/session.cjs`
holds the client, the settings that decide how it starts and the reporting when it cannot,
and serializes start, stop and restart per folder so no two of them run against one client
at once. `extension.cjs` turns editor events into those three verbs and holds no cleanup
knowledge; the pieces of VS Code the sessions touch are injected, so the lifecycle is
driven by tests without an editor.

One project is watched once, by the server asking and the client owning. The adapter no
longer creates a watcher of its own, and the server registers `didChangeWatchedFiles` only
when the client says it takes dynamic registrations, rooted at its own project through a
relative pattern when the client supports one. A client that cannot watch is told so on
stderr rather than left to look watched.

Declared settings are read where they are declared: the client id is `srl`, which is the
contributed configuration section, and a `srl.nodePath` change restarts the folders it
changed for. A folder whose manifest names `@srljs/cli` or `@srljs/core` and has no server
installed is reported with the action that fixes it; a folder that names neither stays
silent.

WebStorm keeps the 2026.1 minimum and states the rename limit in its description and in
the guide rather than implying it with a version the descriptor does not enforce. It
contributes the same six snippets as live templates. A packaging workflow builds the VSIX
and the plugin ZIP on every change.

## Consequences

Stopping a session is the whole of the cleanup, so a restart, a removed folder and a
deactivate all release the same resources by the same path. A multi-root window reloads
one root's model for one root's edit. The trace setting a user sets is the trace setting
the client reads.

The rejected alternative is a server-side file watcher, which would have made freshness
independent of the client. It watches a tree the editor already watches, has to decide
what `node_modules` means on its own, and would have put a second watcher back beside the
one the client keeps — the duplication this record removes. The cost of the decision taken
instead is real: a client that registers no watchers sees on-disk changes outside its open
buffers only after a restart.

Reopen this if a supported editor turns out not to take dynamic watcher registrations, or
if the platform gains a way for a plugin to declare which LSP features it offers per
build, which is what would let the WebStorm descriptor enforce the rename limit rather
than document it.
