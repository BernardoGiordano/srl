/**
 * A `@web/test-runner` configuration for an srl application, so its component tests
 * run the way this repository runs its own.
 *
 *   // web-test-runner.config.mjs
 *   import { testRunnerConfig } from '@srljs/cli/testing/web-test-runner.mjs';
 *
 *   export default testRunnerConfig({ app: 'web' });
 *
 * Tests run in Chrome against the source files the browser loads, with no transform.
 * The runner serves the repository root, where the library sits under
 * `node_modules/@srljs/core/` and the application under `web/`. A deployed page sees
 * the library at `/lib/` and the application at `/`. The middleware rewrites the
 * first shape into the second with `resolveMount` from `cli/origin/`, the rule every
 * srl origin resolves with, so a root-absolute URL in application code resolves in a
 * test as it does in production. ADR-0075, ADR-0126.
 *
 * The page carries the application's own import map, read from its `index.html`, and
 * one entry more, `@srljs/core/testing/harness.js`, the name `exports` gives the
 * published test harness. A test imports the harness under that name in both shapes.
 *
 * `@web/test-runner` is the project's dependency rather than the CLI's, so a project
 * without browser tests installs no browser tooling. Building this configuration
 * loads the runner's default reporter alongside its admission reporter.
 *
 * The runner binds every interface whatever its `hostname`, and serves the whole
 * repository. The first middleware answers only a loopback peer, admits Host the way
 * `cli/origin/` does, and 404s dotfiles such as `.git/` and `.env`. The WebSocket
 * adapter shares peer and Host admission, requires the connection's complete
 * browser Origin, and contains invalid messages and listener failures. ADR-0131.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { LIB_MOUNT_ROUTES, REPO, repoPath } from '../layout.mjs';
import { hidden, resolveMount } from '../origin/index.mjs';
import { MANIFEST, PACKAGE, extractImportMap, fileToUrl } from '../package/interface.mjs';
import { htmlAttribute, runnerAdmission, scriptJson } from './runner-admission.mjs';
import { admitsRunnerRequest, runnerSockets } from './runner-sockets.mjs';

const require = createRequire(import.meta.url);

/**
 * The Trusted Types policies the library and the harness create. A test page enforces
 * Trusted Types, so markup reaches the DOM only through these.
 */
const LIBRARY_POLICIES = ['lit-html', 'ui-test', 'ui-test-template', 'test-harness'];

/** The specifier `exports` publishes the harness under, which a test page also maps. */
export const HARNESS = '@srljs/core/testing/harness.js';

/**
 * @typedef {object} TestRunnerOptions
 * @property {string} app the application directory, relative to the repository root
 * @property {string[]} [files] more test globs, beside `<app>/test/**\/*.test.js`
 * @property {string[]} [policies] Trusted Types policies the application creates
 * @property {number} [timeout] milliseconds one test may take, 4000 by default
 */

/**
 * The application's own entries as URL rewrites, one per top-level file or directory,
 * so a file added at the application root resolves in a test without an edit here.
 *
 * @param {string} app
 * @returns {Array<[string, string]>}
 */
function applicationRoutes(app) {
  const dir = join(REPO, app);
  const base = `/${repoPath(dir)}`;
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !['index.html', 'node_modules'].includes(entry.name) && !entry.name.startsWith('.'))
    .map((entry) =>
      entry.isDirectory()
        ? /** @type {[string, string]} */ ([`/${entry.name}/`, `${base}/${entry.name}/`])
        : /** @type {[string, string]} */ ([`/${entry.name}`, `${base}/${entry.name}`]),
    );
}

/**
 * The import-map element the test page carries.
 *
 * The vendored pins are dropped, because the runner serves `/lib/vendor/` itself and
 * `srl check importmap` already holds those pins against the bytes. A remote's pins
 * stay, because admission requires a remote's entry to be pinned by the page.
 *
 * @param {string} app
 * @returns {string}
 */
function importMapFor(app) {
  const html = readFileSync(join(REPO, app, 'index.html'), 'utf8');
  const { imports, integrity } = extractImportMap(html, `${app}/index.html`);
  const harness = /** @type {Record<string, string>} */ (MANIFEST.exports)['./testing/harness.js'];
  const harnessUrl = harness === undefined ? null : fileToUrl(REPO, join(PACKAGE, harness));
  const pins = Object.fromEntries(
    Object.entries(integrity).filter(([url]) => !url.startsWith('/lib/vendor/')),
  );
  const body = scriptJson(
    { imports: harnessUrl === null ? imports : { ...imports, [HARNESS]: harnessUrl }, integrity: pins },
  );
  return `<script type="importmap">\n${body}\n    </script>`;
}

/**
 * Whether a request path, decoded, names a dotfile. A malformed escape counts, since
 * nothing the runner serves needs one.
 *
 * @param {string} path
 * @returns {boolean}
 */
function hiddenPath(path) {
  try {
    return hidden(decodeURIComponent(path));
  } catch {
    return true;
  }
}

/**
 * The configuration.
 *
 * @param {TestRunnerOptions} options
 * @returns {import('@web/test-runner').TestRunnerConfig}
 */
export function testRunnerConfig(options) {
  const { app } = options;
  const routes = [...LIB_MOUNT_ROUTES, ...applicationRoutes(app)];
  const admission = runnerAdmission([...LIBRARY_POLICIES, ...(options.policies ?? [])]);
  const { defaultReporter } = /** @type {typeof import('@web/test-runner')} */ (require('@web/test-runner'));

  return {
    rootDir: REPO,
    files: [...(options.files ?? []), `${app}/test/**/*.test.js`],
    nodeResolve: false,
    concurrency: 1,
    reporters: [{ start: (args) => admission.start(args) }, defaultReporter()],
    plugins: [runnerSockets((id) => admission.admitsSession(id))],

    middleware: [
      async (ctx, next) => {
        if (!admitsRunnerRequest(ctx.req)) {
          ctx.status = 403;
          return;
        }
        if (hiddenPath(ctx.path)) {
          ctx.status = 404;
          return;
        }
        if (!admission.admits(ctx.URL)) {
          ctx.status = 403;
          return;
        }
        await next();
        if (ctx.response.is('html') && typeof ctx.body === 'string') {
          const protectedDocument = admission.protect(ctx.body);
          ctx.body = protectedDocument.html;
          ctx.set('Content-Security-Policy', protectedDocument.policy);
        }
      },
      async (ctx, next) => {
        // The path only. A query string is the runner's business, and percent escapes
        // are left alone because what is being rewritten is a URL, not a file path.
        const mark = ctx.url.indexOf('?');
        const path = mark === -1 ? ctx.url : ctx.url.slice(0, mark);
        const search = mark === -1 ? '' : ctx.url.slice(mark);
        const match = resolveMount(path, routes);
        if (match !== null) ctx.url = `${match.target}${match.rest}${search}`;
        await next();
      },
    ],

    testFramework: {
      config: { ui: 'bdd', timeout: options.timeout ?? 4000 },
    },

    testRunnerHtml: (testFramework) => `<!doctype html>
<html>
  <head>
    ${importMapFor(app)}
  </head>
  <body>
    <script type="module" src="${htmlAttribute(testFramework)}"></script>
  </body>
</html>`,
  };
}
