# ADR-0127: The project model has more adapters than the editor

- Status: accepted
- Date: 2026-10-06
- Affects: `cli/project-model/index.mjs`, `cli/project-model/types.d.ts`, `cli/project-model/custom-elements.mjs`, `cli/mcp/server.mjs`, `cli/bin/srl.mjs`, `tools/delivery/package-elements.mjs`, `tools/checks/readme-check.mjs`, `tools/checks/pack-check.mjs`, `source/package.json`, `docs/reference/components.md`

## Context

The project model knew every element's inputs, attributes, events and projection names.
Outside this repository it reached two readers. The language server was one, and
`srl model --json` was the other, a document with no version a reader could hold it to.
The component reference lived in the repository's project index, which counted each
element's inputs and events and named none of them. Storybook, IDE plugins and agents
read other formats and got nothing.

Two alternatives lost.

- A separate analyzer for the Custom Elements Manifest, such as the community one, would
  read the source a second time and disagree with the checker about what an element
  offers.
- An MCP server that shelled out to `srl check --json` would parse its own output and
  pay a process per call.

## Decision

**The JSON projection is versioned.** `projectIndex()` carries `schemaVersion: 1`. It
changes when a field is removed or changes meaning, and an added field keeps it.

**A Custom Elements Manifest is an adapter over the model.**
`cli/project-model/custom-elements.mjs` writes schema 2.1.0 from the model, one module
per file, with members, attributes, events, projection slots and both export kinds.
`srl model --custom-elements` prints an application's own elements. `npm run package`
writes the library's manifest to `custom-elements.json`, which the package's
`customElements` field names, and the packaged-install probe reads it from the install.
The model holds no prose, so the manifest carries no descriptions.

**The component reference is generated.** `docs/reference/components.md` lists each
published element's inputs, observed attributes, events, projection and uses by name,
from the same model, and `npm run docs:check` fails when it drifts.

**`srl mcp` is an MCP server over stdio.** Its tools call the check runner, the
catalogue, the model and the shipped documentation in process, and each answers as
structured content with the same JSON as text. It speaks protocol versions
`2025-06-18`, `2025-03-26` and `2024-11-05`. Stdout carries only protocol messages. The
packaged-install probe runs a check and reads a guide through it.

## Consequences

- A new reader of the model costs an adapter, as a new editor costs a launcher
  (ADR-0090).
- A consumer of `srl model --json` written before this sees one more field.
- The MCP server answers one request at a time, so a full check delays the calls
  behind it.
- The MCP server offers tools only. Resources and prompts would need the protocol's
  other capabilities, and nothing asks for them yet.
- Reopen this if a reader needs prose the model does not hold, such as descriptions in
  the manifest, or if the MCP protocol drops the versions listed here.
