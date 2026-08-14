# Getting started: run, check, test

```bash
npm run example                                 # the application, http://localhost:8100
node tools/dev/serve.mjs --open                 # any application, statically, http://localhost:8000
```

`npm run example` is the one to use: it serves `example/` from a Node backend, so the
`bff` token strategy is exercised against a real `HttpOnly` cookie, which no faked
`fetch` can produce, and `/api/*` and the event stream answer for real. Sign in with any
username; the password picks the role — `admin`, `operator` or `viewer`. `/analytics` is
the foreign-stack micro-frontend, `/billing` the same-stack one.

`tools/dev/serve.mjs` is the file-server half of the same layout: the three mounts, a
history fallback and watch-reload, with no npm install and no process behind `/auth` or
`/api`. It is how an application with no backend of its own is served, and how this one
is checked to be a plain static folder.

```bash
npm run check                 # typecheck + templates + lint + tool tests + vendor + verify + docs + browser tests
APP=example npm test          # the library, the collection and that application's suite
npm run benchmark:ci          # the performance gate, against the checked-in baseline
```

Everything `check` runs, individually:

| Command | What fails it |
|---|---|
| `npm run typecheck` | A JSDoc type error anywhere, including tools |
| `npm run templates:check` | A binding that does not typecheck against its component class |
| `npm run lint` | Type-aware ESLint |
| `npm run test:tools` | The Node-side suites: project model, checkers, benchmark integrity, frozen interfaces, docs |
| `npm run vendor` | A vendored byte that does not match its recorded hash |
| `npm run verify` | Layering, dependencies, import maps, template ownership, translations, storage access |
| `npm run docs:check` | A generated reference table that no longer matches the project model |
| `npm test` | The browser suites, in real Chrome, for the library, the collection and one application |

## Run this after changing X

| You changed | Run |
|---|---|
| Any `.js` under `source/` or an application | `npm run check` |
| A `.html` template, a component's public members, or the attribute one observes | `npm run templates:check` |
| A `defineComponent` declaration, a tag, or a module path | `npm run verify && npm run docs:check` |
| An import map, a manifest, or a remote's bytes | `npm run verify` (integrity, CSP hash, grants) |
| A vendored dependency | `npm run vendor` then `npm run verify` |
| Anything in the render, router, table or startup path | `npm run benchmark:ci` |
| Tailwind input or a component's example classes | `npm run css`, then re-read the delivery numbers in [the performance envelope](guide/performance.md) |
| Documentation prose | nothing; generated tables: `npm run docs:write` |
