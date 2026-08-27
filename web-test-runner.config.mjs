/**
 * Tests run in a real browser against the real source files. There is no
 * transform step, no jsdom, and no module mocking layer, because there is
 * nothing to transform: the browser natively imports exactly what ships.
 *
 * TWO SUITES, ONE ORIGIN
 *
 * source/lib/test/  tests the framework, and nothing in it may import from an
 *                   application. If one of these tests needs example to pass,
 *                   the boundary has leaked and that is the bug.
 * source/components/test/
 *                   tests the shared component collection. Same rule: these
 *                   components are built on the library and know no
 *                   application, so their tests must not need one either.
 * <APP>/test/       tests one application end to end, including the real
 *                   manifest fetch, the real router and the real remotes.
 *
 * The application under test is chosen by APP, so a second application is
 * `APP=poc-xyz npm test` and no edit here.
 *
 * WHY THE MIDDLEWARE EXISTS
 *
 * @web/test-runner serves the repository root, where the framework lives at
 * /source/lib/ and the application at /example/. A browser running the deployed
 * application sees neither path: it sees the framework at /lib/ and the
 * application at /. The rewrite below makes the test origin look like the
 * deployed one, which buys two things worth more than the ten lines it costs:
 *
 *   1. The import map the page carries is the application's own, read from its
 *      index.html — the same document production serves — so tests cannot pass
 *      against different bytes than ship.
 *   2. Root-absolute URLs in application code — '/app.manifest.json' in
 *      main.js, the remote URLs in the manifest, the i18n bundle patterns —
 *      resolve in tests without a single test-only branch in the source.
 *
 * The rewrite itself is `resolveMount` from cli/origin/index.mjs: the first
 * matching prefix wins and a prefix matches on a segment boundary, which is the
 * same rule the three file servers over that module resolve with. ADR-0075. This
 * is the one consumer that maps a prefix to another prefix rather than to a
 * directory, because the server being rewritten for is the runner's own.
 *
 * Templates are fetched from disk by the same code path production uses, so a
 * template that fails to compile fails a test rather than a page.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LIB_MOUNT_ROUTES, REPO } from './cli/layout.mjs';
import { resolveMount } from './cli/origin/index.mjs';
import { extractImportMap } from './cli/package/interface.mjs';

const APP = process.env.APP ?? 'example';

/**
 * URL prefix -> URL, exactly as cli/dev/serve.mjs and the release tree mount them: the
 * library mounts are imported from cli/layout.mjs rather than restated, so the
 * test origin cannot drift from the served one. What remains here is the part
 * that is genuinely per application.
 *
 * Order matters: the first match wins, so the library mounts are listed before
 * the application's own prefixes. Anything absent from this table is left alone,
 * which is what keeps the runner's own /__web-dev-server__ URLs, the test files
 * themselves and /node_modules working.
 */
const MOUNTS = /** @type {Array<[string, string]>} */ ([
  ...LIB_MOUNT_ROUTES,
  ['/src/', `/${APP}/src/`],
  ['/remotes/', `/${APP}/remotes/`],
  ['/i18n/', `/${APP}/i18n/`],
  ['/app.manifest.json', `/${APP}/app.manifest.json`],
  ['/app.css', `/${APP}/app.css`],
  ['/templates.json', `/${APP}/templates.json`],
]);

/**
 * The import-map element the test page carries: the application's own map, read from
 * its `index.html`.
 *
 * Derived rather than written out. A literal here was a second copy of the pins, kept
 * honest by a check in tools/checks/verify-deps.mjs that compared the two documents
 * specifier for specifier — and a copy a check exists to compare is still a copy. Two
 * applications could not have shared one anyway: their remotes live at the same URLs
 * with different digests, and `/remotes/billing/remote-entry.js` cannot carry two hashes
 * in one map.
 *
 * The vendored entries are dropped. The runner serves `/lib/vendor` itself and the map's
 * own pins are already asserted against those bytes by `npm run vendor`. Remote artifacts
 * keep theirs: the manifest validator requires a remote's executable URL to be governed
 * by the page's static map, and exercising that is part of what an application's suite is
 * for.
 *
 * @param {string} app
 * @returns {string}
 */
function importMapFor(app) {
  const html = readFileSync(join(REPO, app, 'index.html'), 'utf8');
  const { imports, integrity } = extractImportMap(html, `${app}/index.html`);
  const pins = Object.fromEntries(
    Object.entries(integrity).filter(([url]) => !url.startsWith('/lib/vendor/')),
  );
  const body = JSON.stringify({ imports, integrity: pins }, null, 2);
  return `<script type="importmap">\n${body}\n    </script>`;
}

/** @type {import('@web/test-runner').TestRunnerConfig} */
export default {
  files: [
    'source/lib/test/**/*.test.js',
    'source/components/test/**/*.test.js',
    `${APP}/test/**/*.test.js`,
  ],
  nodeResolve: false,
  concurrency: 1,

  middleware: [
    async (ctx, next) => {
      // The path only. A query string is the runner's business, and percent escapes
      // are left alone because what is being rewritten is a URL, not a file path.
      const mark = ctx.url.indexOf('?');
      const path = mark === -1 ? ctx.url : ctx.url.slice(0, mark);
      const search = mark === -1 ? '' : ctx.url.slice(mark);
      const match = resolveMount(path, MOUNTS);
      if (match !== null) ctx.url = `${match.target}${match.rest}${search}`;
      await next();
    },
  ],

  testFramework: {
    config: { ui: 'bdd', timeout: 4000 },
  },

  testRunnerHtml: (testFramework) => `<!doctype html>
<html>
  <head>
    <meta
      http-equiv="Content-Security-Policy"
      content="trusted-types lit-html ui-test ui-test-template test-harness; require-trusted-types-for 'script'"
    >
    ${importMapFor(APP)}
  </head>
  <body>
    <script type="module" src="${testFramework}"></script>
  </body>
</html>`,
};
