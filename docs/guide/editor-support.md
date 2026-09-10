# Editor support

srl uses one Language Server Protocol implementation for every editor. It runs from the
project's own `@srljs/cli`, reads the same project model as the build, imports the same
template dialect as the browser, and sends unsaved HTML and JavaScript buffers through the
same template checker as `srl check templates`. An editor therefore has no second account
of what a component, binding, or valid expression is.

The server provides:

- diagnostics for template expressions, directives, unknown elements, missing `uses`
  entries, custom-element properties and observed attributes;
- completion for custom elements, bindings, directives, DOM events, component members,
  template globals, loop locals, and `$event`;
- hover and go-to-definition for custom elements, their properties, component members,
  and template globals;
- find references and project-wide rename for custom-element tags, across template files
  and the `html` templates of handwritten Lit components, including their
  `defineComponent()` declaration;
- a quick fix that adds both the import and `uses` entry for a known component;
- semantic highlighting for interpolations and srl attributes, document links, template
  outlines, and workspace element symbols.

Expression completion follows compiler types after a dot: `rows.` offers array members,
loop items keep the iterable's element type, and `$event.` uses the bound element and DOM
event. Loop names leave scope with their element. Tag rename changes parsed start and end
tags, in template files and in the `html` templates a handwritten Lit component writes in
JavaScript, never tag-shaped text in comments, strings or raw `script` and `style`
content, and refuses an identity already registered by another element.

JavaScript editing remains the editor's own JavaScript language service. The srl server
adds the template half and project-model diagnostics; it does not replace JavaScript
completion, formatting, or refactoring.

## Project requirement

Install the matching library and toolchain in the repository. The plugins deliberately use
this copy rather than bundling another version, so a project on srl 0.7 is checked with the
0.7 grammar and a later project can move independently.

```bash
npm install --save-dev @srljs/core@0.8.0 @srljs/cli@0.8.0
```

Node.js 22 or newer must be available. This is already the engine required by
`@srljs/cli`.

## VS Code

Build a VSIX from this repository and install it:

```bash
cd editors/vscode
npm install
npm test
npm run package
code --install-extension srl-0.8.0.vsix
```

The extension starts one server per workspace folder, so a multi-root workspace may hold
projects on different srl versions. Each server watches only its own folder, so one root's
edit reloads one root's model.

Set `srl.nodePath` when `node` is not on the extension host's `PATH`; changing it restarts
the folders it applies to. Use **srl: Restart Language Server** after installing the
toolchain into a folder that did not have it. Protocol traces are available through
`srl.trace.server`, in the **srl Language Server** output channel of the folder they
belong to.

A folder whose `package.json` asks for `@srljs/cli` or `@srljs/core` and has no server
installed says so. A folder that asks for neither is left to VS Code's ordinary HTML and
JavaScript support without comment.

The VS Code package also injects TextMate scopes for `{{ expression }}`, directives,
events, and bindings, and contributes HTML and JavaScript snippets. Ordinary HTML, CSS,
JavaScript, and Emmet support continue to come from VS Code.

## WebStorm

Build the JetBrains plugin with Java 21, then install the ZIP from
**Settings | Plugins | Install Plugin from Disk**:

```bash
cd editors/webstorm
mvn package
```

The artifact is written to `target/srl-webstorm-<version>.zip`. The build resolves the
IntelliJ Platform as ordinary Maven artifacts, so no WebStorm installation is needed to
compile.

The plugin targets WebStorm 2026.1 and newer and uses WebStorm's native LSP client. It
starts only when the project contains the srl server. It runs that server with the `node`
found on the login shell's `PATH` rather than the IDE process's, so an install managed by
nvm, fnm, or Volta is reachable from a desktop-launched IDE; `SRL_NODE_PATH` names a
specific executable instead. A project with no reachable Node.js says so rather than
failing to spawn quietly.

A project whose `package.json` asks for `@srljs/cli` or `@srljs/core` and has no server
installed says so once, in a notification. A project that asks for neither is left to
WebStorm's ordinary HTML and JavaScript support without comment. Opening an srl file again
after installing the dependencies starts the server.

It contributes the same six snippets as the VS Code package, as live templates in the
`srl` group: `srl-interpolation`, `srl-if`, `srl-for`, `srl-event`, `srl-property` and
`srl-component`.

One feature-specific limit: the platform's LSP rename arrives in 2026.1.1. On 2026.1 every
other feature listed at the top of this page works, and renaming a tag is available in VS
Code or by upgrading the IDE.

`mvn -Pverify-plugin verify` runs the IntelliJ Plugin Verifier over the ZIP against an
installed IDE. It defaults to `/Applications/WebStorm.app/Contents`; elsewhere pass
`-Dwebstorm.home=<directory containing lib/>`.

## Conformance

Packaging proves the artifact and the Plugin Verifier proves the plugin loads. Neither
proves that installing one makes an editor start the project's toolchain and answer with
it, so one command does:

```bash
npm run conformance                  # VS Code, minimum and current
npm run conformance -- --webstorm    # and the WebStorm installed on this machine
```

It builds four projects from the tarballs this repository would publish — two installed,
one that declares srl without installing it, one that never asked — installs the packed
extension into a profile of its own, and drives the scenarios in
`tools/conformance/scenarios.mjs` through the editor's own providers. The result is one
parity table over every editor it could reach; `--report <path>` writes it as Markdown.

VS Code answers every scenario. WebStorm answers the session ones — a project that starts
its toolchain, projects that stay quiet, nothing left running — because the platform
exposes no way to ask an installed IDE for a completion from outside it. The table says
which is which on every run. CI runs the VS Code half; WebStorm needs a licensed IDE, so
it is local and opt-in. ADR-0097.

## Other LSP clients

Any client that can start a stdio language server can use the same implementation:

```bash
srl language-server
```

Run it with the repository root as its working directory. `SRL_ROOT` may name that root
explicitly for clients whose server working directory cannot be configured.

The server registers the file watchers it needs through `client/registerCapability`, and
only when the client declares `workspace.didChangeWatchedFiles.dynamicRegistration`. A
client that declares it and `relativePatternSupport` gets patterns rooted at the project,
which is what keeps one project's edits out of another's model. A client that declares
neither is told on stderr that changes made outside its open buffers refresh only on
restart.

## What counts as a template

An `.html` file receives srl semantics when the project model associates it with a static
`defineComponent({ tag, element, ... })` declaration. A sibling template is discovered
without configuration; an explicit literal `template` path works too. Other HTML files
keep ordinary editor HTML support and receive no srl template diagnostics.
