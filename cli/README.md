# @srljs/cli

The srl CLI scaffolds applications, serves source with live updates, checks
templates and messages, runs the language server, and builds production
artifacts. It works with the matching version of
[`@srljs/core`](https://www.npmjs.com/package/@srljs/core).

An application can run in the browser without the CLI. `srl new` adds this
package to every project it writes.

## Start a project

You need Node.js 22 or later, npm, and Git.

```bash
npx @srljs/cli@0.9.0 new my-app
cd my-app
npm install
npm run dev
```

`srl new` writes the project into `my-app/`. It pins `@srljs/core` and
`@srljs/cli` to the same exact version, because the CLI checks templates and
manifests against that version of the runtime. It also pins the Tailwind CLI
and Node types the build uses, and adds `dev`, `check` and `build` scripts, a
`.gitignore`, and an `AGENTS.md` for coding agents. The application in
`my-app/web/` boots through `startApplication` with one route. Pass `--app` to
name it differently. The command installs nothing and refuses a directory that
already exists.

Add to the project from its root.

```bash
npx --no-install srl generate component user-card
npx --no-install srl generate component pages/users-page --styles
npx --no-install srl generate app admin
```

A component goes to `web/src/components/` unless its name starts with a
directory under `web/src/`. `--styles` adds its scoped stylesheet. A template
that names the new tag imports its class and lists it in `uses`. The command
refuses a tag the project already defines and any file that exists.

`npx --no-install` uses the installed binary and will not download another
version.

## Commands

Run commands from the project root. Pass `--app <directory>` when the
project holds more than one application. With one application, the CLI
can discover it.

| Command | What it does |
|---|---|
| `srl new my-app` | Write a new project with one application. |
| `srl generate component user-card` | Add a component and its template. |
| `srl generate app admin` | Add another application to the project. |
| `srl serve --app web --open` | Serve source, library, and components on one origin with history fallback and live updates. |
| `srl check` | Check the project model, types, templates, import map, and messages in one run. |
| `srl check templates importmap` | Run only the named checks: `project`, `types`, `templates`, `importmap`, or `messages`. |
| `srl check messages --write` | Add missing message keys to the default-locale bundle. |
| `srl build --app web` | Produce minified, hash-named assets, checked templates, CSS, and an artifact report. |
| `srl model --app web --json` | List discovered elements, globals, and applications. |
| `srl language-server` | Start the language server over stdio for an editor client. |

`srl check --json` prints every finding with a stable code and a file
position, and exits non-zero when any finding is an error.
`srl check --codes` explains each code. `srl --help` lists the remaining
commands and options. The
[editor guide](https://github.com/BernardoGiordano/srl/blob/main/docs/guide/editor-support.md)
covers VS Code, WebStorm, and generic LSP clients.

The development server can proxy backend paths on the same origin as the
application. Repeat `--proxy` for more than one path.

```bash
npx --no-install srl serve --app web \
  --proxy /api/=http://127.0.0.1:8001 \
  --proxy /auth/=http://127.0.0.1:8001
```

The prefix stays in the forwarded request path. Status and headers pass
through. This setup lets a cookie session use the same origin in development
and deployment.

## Application layout and types

An application is a directory at the repository root with an `index.html`.
The tools discover its manifest, modules, templates, and locale files from
there. Set `SRL_ROOT` when the srl checkout is nested under another root.

```text
my-app/
  package.json
  tsconfig.json
  web/
    index.html
    app.manifest.json
    i18n/en.json
    src/
  node_modules/@srljs/core/
```

The scaffold writes a root `tsconfig.json` that extends the core package's
base configuration. That configuration resolves `@core/` and `@components/`
to the declarations generated from the browser's JavaScript source.

```json
{
  "extends": "@srljs/core/tsconfig.base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["web/**/*.js"]
}
```

Add another path to `include` for a second application. `srl generate app`
says which one.

## Production build

The build reads the application's import map and refuses imports it cannot
resolve. It runs the project model and template checks, refuses on any error,
and writes minified JavaScript chunks, CSS, templates, integrity pins, and
`dist/<app>/artifact.json`. The report lists
the emitted files, chunk graph, sizes, and security metadata. The app needs
at least one dynamic import so it produces more than an entry chunk.

```bash
npm run check
git init
git add .
git commit -m "Create my-app"
npm run build
```

The build calls the project's Tailwind CLI to compile its stylesheet.
[`@srljs/core`](https://www.npmjs.com/package/@srljs/core) supplies the
browser runtime, while this package pins Vite, TypeScript, and parse5 for
the build and checks. The [delivery guide](https://github.com/BernardoGiordano/srl/blob/main/docs/guide/delivery.md)
describes template modes and artifact verification.

## Module APIs

The `srl` command dispatches to modules that also run by path. A script can
call the build and read its report directly.

```js
import { buildArtifact } from '@srljs/cli/delivery/build.mjs';
import { readReport } from '@srljs/cli/delivery/artifact-report.mjs';

await buildArtifact({ app: { name: 'web', dir: '/abs/path/web' } });
const { report } = await readReport('dist/web');
console.log(report.totals.brotli);
```

For browser tests, `serveOrigin()` serves an application with the same mount
rules and history fallback as the development server. It accepts `route`,
`transform`, `headers`, and `fallback` adapters.

```js
import { serveOrigin } from '@srljs/cli/origin/index.mjs';
import { MOUNTS } from '@srljs/cli/package/interface.mjs';

const appDir = '/abs/path/web';
const origin = await serveOrigin({
  mounts: [...MOUNTS, ['/', appDir]],
  fallback: `${appDir}/index.html`,
});

// Close the origin after the tests finish.
await origin.close();
```

The [testing guide](https://github.com/BernardoGiordano/srl/blob/main/docs/guide/testing.md)
shows the component harness and browser setup.

## Documentation

This package ships the srl documentation for its version. `llms.txt` at the
package root lists every guide, reference page, and decision record under
`docs/`. `docs/reference/diagnostic-codes.md` explains every code `srl check`
reports. A source comment that cites `ADR-0072` refers to
`docs/adr/0072-*.md`.

## Release and license

`srl release` stages a verified artifact. `srl verify-release` checks a staged
tree, `srl verify-http` checks a live origin, and `srl retention` prunes old
releases.

```bash
npx --no-install srl release --artifact dist/web --out staged --remote-root /srv/www/example.com
```

The CLI depends on Vite 8.2.1, TypeScript 6.0.3, and parse5 6.0.1. It is
MIT licensed. See [LICENSE](LICENSE).
