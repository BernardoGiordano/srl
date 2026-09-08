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
- find references and project-wide rename for custom-element tags, including their
  `defineComponent()` declaration;
- a quick fix that adds both the import and `uses` entry for a known component;
- semantic highlighting for interpolations and srl attributes, document links, template
  outlines, and workspace element symbols.

JavaScript editing remains the editor's own JavaScript language service. The srl server
adds the template half and project-model diagnostics; it does not replace JavaScript
completion, formatting, or refactoring.

## Project requirement

Install the matching library and toolchain in the repository. The plugins deliberately use
this copy rather than bundling another version, so a project on srl 0.7 is checked with the
0.7 grammar and a later project can move independently.

```bash
npm install --save-dev @srljs/core@0.7.0 @srljs/cli@0.7.0
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
code --install-extension srl-0.7.0.vsix
```

The extension starts one server per workspace folder, so a multi-root workspace may hold
projects on different srl versions. Set `srl.nodePath` when `node` is not on the extension
host's `PATH`. Use **srl: Restart Language Server** after changing that setting. Protocol
traces are available through `srl.trace.server` and the **srl Language Server** output
channel.

The VS Code package also injects TextMate scopes for `{{ expression }}`, directives,
events, and bindings, and contributes HTML and JavaScript snippets. Ordinary HTML, CSS,
JavaScript, and Emmet support continue to come from VS Code.

## WebStorm

Build the JetBrains plugin with Java 21, then install the ZIP from
**Settings | Plugins | Install Plugin from Disk**:

```bash
cd editors/webstorm
./gradlew buildPlugin
```

The artifact is written under `build/distributions/`. The plugin targets WebStorm 2026.1
and newer and uses WebStorm's native LSP client. It starts only when the project contains
the srl server. Set `SRL_NODE_PATH` in WebStorm's environment when `node` is not on its
`PATH`. Set `WEBSTORM_HOME` to a local WebStorm installation before building to avoid
downloading a separate target IDE.

## Other LSP clients

Any client that can start a stdio language server can use the same implementation:

```bash
srl language-server
```

Run it with the repository root as its working directory. `SRL_ROOT` may name that root
explicitly for clients whose server working directory cannot be configured.

## What counts as a template

An `.html` file receives srl semantics when the project model associates it with a static
`defineComponent({ tag, element, ... })` declaration. A sibling template is discovered
without configuration; an explicit literal `template` path works too. Other HTML files
keep ordinary editor HTML support and receive no srl template diagnostics.
