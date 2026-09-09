# ADR-0097: An installed editor is proved by installing it

- Status: accepted
- Date: 2026-09-09
- Affects: `tools/conformance/`, `tools/fixtures/installed-layout.mjs`, `.github/workflows/editors.yml`, `editors/vscode/`, `editors/webstorm/`

## Context

The two plugins are the only things in this repository a user installs rather than
imports, and until now nothing installed them. `npm run package` proves the VSIX bundles
and lays out; `mvn package` proves the ZIP compiles against the platform and the Plugin
Verifier proves it loads. Every claim past that point was checked against a mock: the VS
Code session suite injects `vscode`, `createClient` and `locate`; the WebStorm suite
injects the filesystem, the reporter and the LSP starter. Both are the right tests for
what they cover, and neither can fail when an installed extension does not activate,
when a contributed setting is spelled wrong, or when an editor's own provider never
reaches the server.

The behaviour docs/guide/editor-support.md promises — one server per folder, a project
that is not srl left in silence, a restart that picks up an installed toolchain, watchers
scoped to a project — was therefore knowledge held in two unrelated CI workflows and a
manual page, and its only interaction test was a person trying it.

Rejected: `@vscode/test-electron` as the harness. It is the standard way to run one VS
Code extension's tests, and this is not that: it is one description of what *every* srl
editor client must do, from which each editor answers what its platform allows. Resolving
a version and spawning an editor is about sixty lines here; a per-editor harness would
have put the scenario list in whichever editor's test framework was written first, which
is the arrangement being removed.

Rejected: a headless entry point in the shipped WebStorm plugin — a
`com.intellij.appStarter` that opens the project, drives `LspServerManager` and prints
answers. It would give WebStorm the language scenarios too. It also puts a test-only
command inside the artifact every user installs, to buy coverage of a server that is
already the same process VS Code drives. Not now; see the reopening condition.

Rejected: asserting the notification text an installed editor shows. No VS Code API reads
a notification and no IntelliJ API exposes one to an observer outside the IDE. The
messages stay asserted where they can be: `editors/vscode/test/session.test.cjs` and
`SrlEditorSessionTest`.

## Decision

Installed-editor behaviour is one module, `tools/conformance/`, and the editors are
adapters over it.

`scenarios.mjs` is the list, as data: an `ask`, the document and anchor it is made at, and
what the answer must contain. Anchors are found by searching the fixture's own text, so a
scaffold that gains a line does not move them. `fixture.mjs` builds four projects — two
installed, one that declares srl without installing it, one that never asked — from the
tarballs this repository would publish and the published `srl new`, sharing
`tools/fixtures/installed-layout.mjs` with the packaged-install probe.

Each adapter answers what its platform allows and says so for the rest. The VS Code
adapter downloads the editor at the minimum version `engines.vscode` claims and at
current stable, installs the packed VSIX into a profile of its own, and drives the
editor's own providers from a probe extension inside the extension host: an answer comes
from the same code path a user's keystroke does. The WebStorm adapter installs the packed
ZIP into a plugins directory of its own, opens each fixture project and asks the running
IDE to open a file in it through the platform's own URL protocol, because the plugin acts
on a file being opened and a project opened from the command line has no editor tab. It
answers the session scenarios and reports the language scenarios `unavailable`. It runs against the
IDE's own configuration directory, because that is where the licence an IDE refuses to
start without lives.

Session evidence is the process census, `servers.cjs`, read by both the driver and the
probe. A window that claims to serve a folder and holds no language server for it is not
serving it, and one that holds two has leaked the first. That is the fact that survives
across editors, which is what makes one scenario list possible at all.

The run emits one parity report over every editor it could reach, so a scenario one editor
answers and the other cannot is visible in the table rather than implied by which workflow
happened to run.

CI runs the VS Code adapter, both editions, in the `editors` workflow. WebStorm needs an
installed and licensed IDE, so it is opt-in and local: `npm run conformance -- --webstorm`.
Conformance is not part of `npm run check`: the contract CONTRIBUTING states is what a
contributor can run in a checkout, and a 130 MB editor download is not that.

## Consequences

CI grows a job that downloads two editors and runs each against the fixture, about six
minutes and 450 MB of transfer, cached between runs on the same machine only. That is the
price of knowing the artifact a user installs does anything at all.

The first run found a defect no mock could hold. Each folder's client was given a
`RelativePattern` document selector rooted at its folder; a language client round-trips
that selector through the protocol before registering the editor's providers with it, and
the relative pattern converts to `undefined` on the way back. Every folder's providers
therefore claimed every folder's files, and with two srl projects open in one window a
rename issued in the first edited the second's files. `editors/vscode/session.cjs` now
scopes the selector with an absolute glob string, which survives the trip.

The editor archives are not integrity-checked, unlike everything in `source/lib/vendor`.
They are a tool a run drives rather than a byte that ships, and the URL is the update
service's own.

WebStorm answers three of the scenarios and VS Code all of them. The report says so on
every run, which is the honest form of a gap that used to be invisible.

The WebStorm run sets `idea.trust.all.projects`. An untrusted project is opened with
everything that runs code switched off, this plugin included, and the dialog that asks is
one no script can answer. It applies to the run's own properties file and to the fixture
projects it opens, never to the IDE somebody works in.

The trace scenario reads the output-channel log VS Code persists under its logs directory.
That is an implementation detail of the editor rather than a contract, so the scenario
reports itself unavailable rather than failing when no such file is found.

This reopens if the platform gains a way to ask an installed IntelliJ IDE for a completion
from outside it, or if WebStorm language coverage becomes worth a headless starter in the
shipped plugin — at which point the scenario list is already the thing that starter would
be driven by. It also reopens if the fixture stops resembling what `srl new` writes, which
would make the run prove an application nobody has.
