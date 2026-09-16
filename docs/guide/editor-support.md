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
npm install --save-dev @srljs/core@0.9.0 @srljs/cli@0.9.0
```

## VS Code

Build and install the extension from this repository.

```bash
cd editors/vscode
npm install
npm test
npm run package
code --install-extension srl-0.9.0.vsix
```

The extension starts one server per workspace folder and watches each folder
separately. Set `srl.nodePath` if Node is absent from the extension host's
`PATH`. Changing it restarts affected sessions. The **srl: Restart Language
Server** command checks folders again after installing dependencies.
`srl.trace.server` writes protocol traces to the folder's output channel.

A folder that declares srl but lacks an installed server gets a message. Other
folders keep ordinary VS Code HTML and JavaScript support. The extension also
adds syntax scopes and snippets for srl markup.

## WebStorm

Build with Java 21 and install the resulting ZIP through **Settings | Plugins |
Install Plugin from Disk**.

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
