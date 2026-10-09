# Editor support

The srl language server runs from a project's `@srljs/cli`. It uses the same
project model, template grammar, and message catalog as the command-line
checks. VS Code and WebStorm launch that server rather than implementing
another checker.

The server provides template and message diagnostics, completion, hover,
definitions, references, tag rename, semantic highlighting, and document
symbols. A quick fix adds the import and `uses` entry for a known component.
Diagnostics also cover unknown elements, unsupported attributes, and message
placeholders a call does not supply.

Completion follows types through member access, loop locals, and `$event`.
Tag rename changes parsed tags and their component declaration across
templates. It leaves matching text in comments and unrelated strings alone.

## Inline Lit templates

The server recognizes `html` and `svg` tagged templates in JavaScript.
It answers element and binding questions in Lit syntax.

| Feature | srl template | Inline Lit |
|---|---|---|
| Property | `[.row-key]="expr"` | `.rowKey=${expr}` |
| Event | `(click)="pick($event)"` | `@click=${pick}` |
| Boolean attribute | `[?disabled]="busy"` | `?disabled=${busy}` |
| Condition and loop | `*if`, `*for` | JavaScript in `${…}` |

The editor's JavaScript service handles the code inside Lit substitutions.
The srl server handles tags and their bindings. A tag in either template form
still needs a `uses` entry.

## Project requirements

Install matching versions of the library and toolchain. The plugin uses the
server in the project, so each workspace gets its own grammar version. The CLI
requires Node.js 22 or newer.

```bash
npm install --save-dev @srljs/core@1.1.0 @srljs/cli@1.1.0
```

## VS Code

A release tag publishes the extension, `bernardogiordano.srl`, to the Visual
Studio Marketplace and Open VSX once the repository holds their tokens. To try a
change, build and install it from this repository.

```bash
cd editors/vscode
npm install
npm test
npm run package
code --install-extension srl-1.1.0.vsix
```

The extension starts one server per workspace folder and watches each folder
separately. Set `srl.nodePath` in user settings if Node is absent from the
extension host's `PATH`. A workspace's own settings can't set it, because a
cloned repository must not choose the executable the editor runs. Changing it
restarts affected sessions. The extension stays off in Restricted Mode, since
it starts the language server from the workspace's `node_modules`. The **srl: Restart Language
Server** command checks folders again after installing dependencies.
`srl.trace.server` writes protocol traces to the folder's output channel.

A folder that declares srl but lacks an installed server gets a message. Other
folders keep ordinary VS Code HTML and JavaScript support. The extension also
adds syntax scopes and snippets for srl markup.

## WebStorm

A release tag publishes the plugin, `dev.santella.srl`, to the JetBrains
Marketplace once its first version is listed there. To try a change, build with
Java 21 and install the resulting ZIP through **Settings | Plugins | Install
Plugin from Disk**.

```bash
cd editors/webstorm
mvn package
```

The plugin targets WebStorm 2026.1 and newer. It uses WebStorm's LSP client
and starts the project's installed server. It finds Node from the login shell
environment; `SRL_NODE_PATH` can choose a specific executable. A declared
project with missing dependencies or Node receives a notification.

Live templates in the `srl` group provide interpolation, conditionals,
loops, events, properties, and component declarations. Tag rename needs
WebStorm 2026.1.1 or newer. `mvn -Pverify-plugin verify` checks the ZIP
against an installed IDE.

## Installed-editor checks

```bash
npm run conformance
npm run conformance -- --webstorm
```

Conformance installs packed packages into fixture projects and drives the
installed editor. The VS Code run covers language features. WebStorm covers
the session scenarios available through its external interface. CI runs the
VS Code half; WebStorm needs a local licensed IDE. Use `--report <path>` to
write the result as Markdown.

## Other LSP clients

A client that can start a stdio language server can run:

```bash
srl language-server
```

Run it from the project root or set `SRL_ROOT`. Clients that support dynamic
file watcher registration receive project-scoped watchers. Without that
capability, changes outside open buffers require a restart.

An `.html` file receives srl template behavior when the project model links
it to a static `defineComponent()` declaration. Other HTML files keep the
editor's ordinary HTML support.

## Agents and other tools

`srl mcp` runs a Model Context Protocol server over stdio for a coding agent.
It reads the same project model and runs the same checks as the language
server.

| Tool | Answer |
|---|---|
| `check` | The `srl check` findings, with codes, files and positions. `subjects` and `app` narrow the run. |
| `codes` | Every diagnostic code and its meaning. |
| `elements` | Every element an application can use. |
| `element` | One element's inputs, attributes, events, projection names and users. |
| `docs` | `llms.txt`, or one page of the documentation the installed packages ship. |

A client that reads the common `mcpServers` configuration starts it from the
project root.

```json
{ "mcpServers": { "srl": { "command": "npx", "args": ["--no-install", "srl", "mcp"] } } }
```

Tool answers carry the project's own text, such as file names, element names,
template source and message strings. An agent reads them as data about the
project. In a repository you don't trust, that text can be written to look like
instructions, so keep the agent's approvals on when it works there.

Two more adapters read the same model.

- `srl model --json` prints the whole model. `schemaVersion` changes only when a
  field is removed or changes meaning.
- `srl model --custom-elements` prints the application's elements as a Custom
  Elements Manifest. `@srljs/core` ships its own as `custom-elements.json`,
  named by the `customElements` field Storybook and IDE plugins read.
