# ADR-0090: One language server behind thin editor clients

- Status: accepted
- Date: 2026-09-08
- Affects: `cli/language-server/`, `editors/vscode/`, `editors/webstorm/`, `cli/checks/template-check.mjs`

## Context

The template checker and the project model already knew what an editor needs. Native integrations for VS Code and WebStorm would each parse templates and discover components again, and drift apart. A toolchain bundled into each plugin could disagree with the version the project installs.

## Decision

`@srljs/cli` runs one Language Server Protocol server over stdio. Its features adapt the project model and the template checker, and add no second grammar. VS Code and WebStorm are launchers that start the server from the project's own `node_modules/@srljs/cli`.

The server has four parts.

- `analysis.mjs` owns document lifetime and staleness. A change marks stale every open template whose check reads the changed file. The queue yields between documents so requests still get answers, and a document edited during its own check goes back in the queue.
- `validation.mjs` runs diagnostics on a worker thread with its own compiler. A shared integer cancels checks whose document went stale. There is no time budget, and a crashed thread fails its pending checks instead of reporting none.
- `semantics.mjs` builds one tolerant snapshot of the template text. Completion, hover, rename, references, semantic tokens and quick fixes all ask it what an offset means. TypeScript stays the authority on expression types.
- `authoring.mjs` gives JavaScript `html` tagged templates their own adapter, which answers in Lit syntax.

`editors/vscode/session.cjs` owns a session's lifetime and serializes start, stop and restart per folder. The server registers file watchers only when the client supports dynamic registration, so each project is watched once.

## Consequences

- Any LSP editor gets diagnostics, completion, navigation, rename, quick fixes, semantic tokens, links, outlines and workspace symbols. A new editor costs a launcher.
- The plugins need `@srljs/cli` and Node.js 22 in the project, which keeps editor and runtime versions paired.
- A cold start pays for two compilers. Warm checks don't block keystrokes.
- A client without watcher registration sees on-disk changes outside its open buffers only after a restart.
