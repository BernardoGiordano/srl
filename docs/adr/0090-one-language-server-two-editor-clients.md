# ADR-0090: One language server, with thin editor clients

- Status: accepted
- Date: 2026-09-03
- Affects: `cli/language-server/`, `editors/vscode/`, `editors/webstorm/`, `cli/checks/template-check.mjs`

## Context

The template checker already returned positioned diagnostics for in-memory markup, and
the project model already held component identity, templates, `uses`, properties, and
observed attributes. Neither was connected to an editor. VS Code and WebStorm could each
grow a native integration, but two integrations would parse the template language twice,
discover components twice, and disagree whenever either copy missed a dialect change.

Bundling a fixed toolchain in each plugin avoids a project dependency but creates another
mismatch: a plugin updated independently from the application can validate 0.7 source
with a later grammar, or offer a binding the installed runtime does not understand.

Template checking also used only files on disk. Passing unsaved markup was supported, but
an unsaved change to its JavaScript host remained invisible until save, which makes an
otherwise interactive diagnostic stale.

## Decision

One Node process in `@srljs/cli` speaks Language Server Protocol over stdio. Language
features adapt the existing project model and template checker; they do not define a
second grammar or component index. The checker accepts an optional map of unsaved source
files, which its compiler host reads ahead of disk and ahead of its cached program.

VS Code and WebStorm are thin launchers. Both resolve the language server from the opened
project's own `node_modules/@srljs/cli`, with the checkout path as the development form.
VS Code starts one process per workspace folder. WebStorm uses its native project-wide LSP
client. Syntax scopes and snippets remain editor resources because LSP does not own those
declarative editor features.

Tag rename is project-wide because a custom-element tag is one static identity in the
model. JavaScript symbol refactors stay with each editor's JavaScript service; the srl
server has no reason to replace it.

## Consequences

Every LSP-capable editor can share diagnostics, completion, navigation, references,
rename, quick fixes, semantic tokens, links, outlines, and workspace symbols. Adding an
editor costs a launcher rather than another language implementation.

The plugins require `@srljs/cli` and Node.js 22 in the project environment. That is the
same toolchain a repository already installs to check and deliver an srl application, and
it keeps editor and runtime versions paired. WebStorm support starts at build 261, where
the platform LSP API used by the adapter is available.

An unsaved JavaScript override cannot reuse TypeScript's old program because the compiler
may retain a source file without asking the host for it. Those checks rebuild the program;
saved-file and template-only checks retain the cached path from ADR-0039. Reopen this
decision if TypeScript exposes a versioned host interface that permits both correctness
and structural reuse for overlays.

ADR-0091 narrows that rule without waiting for such an interface: a program built while a
buffer differed from disk is reused for exactly that buffer text, since every file it may
have retained is then still the text the next check is about.

ADR-0092 concentrates incomplete-template context, scope, compiler-backed expression
members, and structural edit planning in one semantic snapshot used by every language
feature.

ADR-0094 keeps the launchers thin without keeping them careless: a session owns the
resources it started, one project is watched once by the client the server asks, and the
settings each plugin declares are the settings it reads.
