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
 * without browser tests installs no browser tooling. This module only builds the
 * configuration object and imports nothing from it.
 *
 * The runner binds every interface whatever its `hostname`, and serves the whole
 * repository. The first middleware answers only a loopback peer, admits Host the way
 * `cli/origin/` does, and 404s dotfiles such as `.git/` and `.env`. ADR-0131.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { LIB_MOUNT_ROUTES, REPO, repoPath } from '../layout.mjs';
import { admitsHost, hidden, resolveMount } from '../origin/index.mjs';
import { MANIFEST, PACKAGE, extractImportMap, fileToUrl } from '../package/interface.mjs';

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
  const body = JSON.stringify(
    { imports: harnessUrl === null ? imports : { ...imports, [HARNESS]: harnessUrl }, integrity: pins },
    null,
    2,
  );
  return `<script type="importmap">\n${body}\n    </script>`;
}

/**
 * Whether a socket's peer is this machine. A test browser always is, and anything
 * else reached the runner over the network.
 *
 * @param {string | undefined} address
 * @returns {boolean}
 */
function loopbackPeer(address) {
  if (address === undefined) return false;
  const v4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  return v4 === '::1' || v4.startsWith('127.');
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
  const policies = [...LIBRARY_POLICIES, ...(options.policies ?? [])].join(' ');

  return {
    rootDir: REPO,
    files: [...(options.files ?? []), `${app}/test/**/*.test.js`],
    nodeResolve: false,
    concurrency: 1,

    middleware: [
      async (ctx, next) => {
        if (!loopbackPeer(ctx.req.socket.remoteAddress) || !admitsHost(ctx.get('host'))) {
          ctx.status = 403;
          return;
        }
        if (hiddenPath(ctx.path)) {
          ctx.status = 404;
          return;
        }
        await next();
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
    <meta
      http-equiv="Content-Security-Policy"
      content="trusted-types ${policies}; require-trusted-types-for 'script'"
    >
    ${importMapFor(app)}
  </head>
  <body>
    <script type="module" src="${testFramework}"></script>
  </body>
</html>`,
  };
}
