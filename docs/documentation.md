# Documentation and source comments

The root [README](../README.md) introduces srl and gets a reader to a running
application. `docs/guide/` explains how to use each feature. `docs/reference/`
holds generated facts about the source. The [decision records](adr/) explain why
an architectural choice was made.

The published packages have their own READMEs. A reader installing
`@srljs/core` or `@srljs/cli` may never see this repository, so each package
needs a short entry point. Feature details belong in the guides, where there is
one page per subject.

Both packages also ship this whole `docs/` tree, with an `llms.txt` index at
the package root. `npm run package` writes the copies. It refuses a page whose
relative link names a file the package does not contain. Links inside `docs/`
work, and `../README.md` lands on the package README. It also refuses a guide or reference page that `docs/README.md` does not list,
because `llms.txt` is built from that index. Name source files in prose or link
to them by repository URL. ADR-0121 explains the arrangement.

| Information | Put it in |
|---|---|
| First steps and project overview | Root `README.md` |
| Package entry point | `source/README.md` or `cli/README.md` |
| Feature behavior and examples | The relevant page in `docs/guide/` |
| Facts derived from source | Generated blocks in `docs/reference/` |
| Template syntax and its rules | `dialect.js`, which generates `docs/reference/template-dialect.md` |
| What a diagnostic code means | `cli/diagnostics/catalog.mjs`, which generates `docs/reference/diagnostic-codes.md` |
| Decision and its tradeoffs | One record in `docs/adr/` |
| Rule the project can enforce | A type, test, or verifier check |
| Local reason a reader needs beside code | A short source comment |

JSDoc types are part of the checked JavaScript and must stay with the code. A
prose comment should explain a rule or a surprising choice. Git history records
past approaches, so comments can describe the current behavior.

Use an ADR number when a source comment needs to point to a longer decision.
The number survives file moves and changes to guide headings.

```js
// A link click has no caller to receive a rejection. ADR-0003.
```

Generated sections should be updated through their commands. The checks report
missing markers, stale tables, malformed records, and broken citations.

```bash
npm run docs:check
npm run docs:write
npm run docs:adr
npm run docs:adr:write
```
