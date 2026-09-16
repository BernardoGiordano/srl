# Getting started

Run the example with its Node backend to try sign-in, API calls, and live updates.

```bash
npm run example
```

Open <http://localhost:8100>. Enter any username and use `admin`, `operator`, or
`viewer` as the password to choose a demo role. The analytics and billing pages
show two ways to mount a remote application.

The static server is useful when you are working on an application without a
backend. It serves the application, library, and components from one origin and
reloads changed files. The example's sign-in and API routes need its Node backend.

```bash
node cli/dev/serve.mjs --app example --open
```

Neither server needs `npm install`. The checks and tests do.

```bash
npm install
npm run check
```

`npm run check` runs type checking, template checking, lint, Node and editor tests,
the browser suite, package and dependency checks, and documentation checks. To run
one part while editing, use the commands below.

| Change | Check |
|---|---|
| JavaScript or JSDoc | `npm run typecheck && npm run lint` |
| Component template or public member | `npm run templates:check` |
| Import map, manifest, remote, or dependency | `npm run verify` |
| Message key or locale bundle | `npm run messages:check` |
| Generated documentation table | `npm run docs:check` |
| Browser behavior | `APP=example npm test` |
| Editor or language server | `npm run test:tools && npm run test:editors` |
| Release output | `npm run build -- --app example` |

The [benchmark guide](guide/performance.md) explains the performance gate. The
[browser support guide](guide/browser-support.md) records the cross-browser
journey and the builds that ran it.
