# ADR-0010: Manifest admission is one whole-document decision

- Status: accepted
- Date: 2026-08-12
- Affects: `source/lib/core/remotes/manifest-policy.js`, `tools/checks/verify-deps.mjs`

## Context

`app.manifest.json` is fetched on every load. It decides where executable code is
imported from, where credentials are sent, which path each remote owns, and which files
the locale and template caches are seeded from.

Validating those fields one at a time — the shape most configuration loaders have — cannot
answer the questions that matter, because every dangerous case is locally valid. A token
endpoint on another origin is a perfectly good string. Two remotes claiming `/billing` are
two perfectly good entries. A mount that swallows another remote's subtree misbehaves
only later, inside the router, where declaration order silently decides whose guard and
whose grants apply.

## Decision

Cross-field decisions are made once, in `manifest-policy.js`, before anything downstream
is constructed. Everything after that module reads admitted values — normalized,
collision-checked and frozen — rather than the parsed document. A consumer that re-reads a
raw manifest string is re-deciding policy in a place that cannot see the rest of the file,
and that is the thing this module exists to make impossible.

The module imports nothing, for the same reason `template/dialect.js` imports nothing:
`tools/checks/verify-deps.mjs` loads it in Node and admits every checked-in manifest
against the rules the browser applies at startup. A manifest that would fail in
production fails in `npm run verify` first. The two adapters differ only in where the
page's import-map pins come from, which is why those arrive as an argument rather than
being read from `document`.

## Consequences

The boundary is sharp and has to stay that way: URL shape and trust, cross-field
collisions and the normalized shape belong here; fetching the document and reading the
page's import map belong to `remotes/mfe.js`; anything that acts on an admitted manifest
belongs downstream.

The cost is that a new manifest field has to be admitted here before it can be read
anywhere, which is one extra edit and the reason a field cannot quietly enter the system.

Reopen only if the manifest stops being fetched at runtime — a compiled-in configuration
has a different threat model and would not need a runtime admission step at all.
