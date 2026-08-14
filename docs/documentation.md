# Documentation and source comments

Three durable surfaces, and the split between them is the same one the code uses.
`README.md` is the interface: what this is, how to run it, one working component, and
where everything else lives. `docs/` is the implementation of that interface — the manual,
one subject per page. `docs/adr/` is the reasoning behind both — one decision per file,
each with a number that never changes.

Nothing else. There are still no READMEs under `source/` — a manual in the directory
somebody edits first is the one that goes stale — and no fourth surface: knowledge lives
in a page here, in a record, in a type, in a test, or in an executable check.

All of it is generated against reality where it can be:

```bash
npm run docs:check    # fails when a generated table drifts from the project model
npm run docs:write    # regenerate them
npm run docs:adr      # fails on a malformed record or a citation that resolves to nothing
npm run docs:adr:write # regenerate the record index
```

Both run inside `npm run check`. `docs:check` also refuses a missing marker, a duplicate
marker, an unterminated block and a generated name it does not produce — all four mean the
document and the generator disagree about what is generated. `docs:adr` additionally
refuses a README section number cited from source, and project-phase vocabulary in a
permanent file.

Where knowledge goes, and why each destination is the one that keeps it true:

| Kind of knowledge | Destination |
|---|---|
| What this is, and the first thing to run | `README.md`, and nothing longer |
| Caller-facing interface rule | The page in `docs/guide/` that owns the subject |
| A fact derived from the source | A generated block in `docs/reference/`, never typed by hand |
| How a decision was reached, and what would reopen it | A record in `docs/adr/`, cited by number |
| Enforceable invariant | A type, a runtime validation, or a verifier check |
| Behavioural claim | A test name and its assertion |
| Security-sensitive local warning | A concise source comment, plus [the security model](guide/auth-and-remotes.md) |
| Required JSDoc type | Source. It is executable static information |
| What happened, and when | Git history |
| Repeated usage example | One example, on the page that owns the subject |
| Non-obvious algorithm reason | A concise local source comment |

A page in `docs/guide/` owns one subject completely. Splitting a subject across two pages
is how the second one starts disagreeing with the first, which is the failure the
single-file rule was protecting against and the one this structure has to keep refusing.

Type-bearing JSDoc is not a comment in the removable sense: this project typechecks
`.js` with JSDoc, so "remove comments" must never mean "break typechecking". What source
comments must *not* carry is design-notebook prose — the narrative of how a decision was
reached. In a buildless architecture, prose in a module on the critical path is shipped
bytes. A comment states the rule and cites the record:

```js
// State rather than a rejection: a link click has no caller to reject at. ADR-0003.
```

Cite by record number, never by section number and never by file path. A number survives
every reorganisation of this directory; `§12` is wrong the moment a section is inserted
above it, and `docs/guide/auth-and-remotes.md` is wrong the moment a page is renamed —
which is why `docs:adr` fails on a section number appearing in `source/`, `tools/` or an
application directory.
