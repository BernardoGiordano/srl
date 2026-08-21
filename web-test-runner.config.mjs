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
 *   1. The import map below is the same map as the application's index.html,
 *      specifier for specifier and URL for URL. tools/checks/verify-deps.mjs asserts
 *      that, so a divergence fails `npm run check` rather than producing tests
 *      that pass against different bytes than production runs.
 *   2. Root-absolute URLs in application code — '/app.manifest.json' in
 *      main.js, the remote URLs in the manifest, the i18n bundle patterns —
 *      resolve in tests without a single test-only branch in the source.
 *
 * Remote integrity pins are duplicated below on purpose. Unlike vendor imports,
 * the runtime manifest validator requires its executable URL to be governed by
 * the page's static import map. tools/checks/verify-deps.mjs checks these copies against
 * the application map, so a stale test pin fails before the browser suite runs.
 *
 * Templates are fetched from disk by the same code path production uses, so a
 * template that fails to compile fails a test rather than a page.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LIB_MOUNT_ROUTES, REPO } from './tools/layout.mjs';
import { extractImportMap } from './tools/package/interface.mjs';

const APP = process.env.APP ?? 'example';

/**
 * The application whose map is written out literally below.
 *
 * The literal is what `tools/checks/verify-deps.mjs` compares against that application's
 * `index.html`, specifier for specifier and pin for pin, so a divergence fails
 * `npm run check` rather than producing tests that pass against different bytes than
 * production runs. It can only be compared for one application, because two applications'
 * remotes live at the same URLs with different digests: `/remotes/billing/remote-entry.js`
 * cannot carry two hashes in one map.
 *
 * So every other application's map is read from its own `index.html` instead — see
 * `importMapFor` below. Nothing is duplicated for those, and nothing can drift.
 */
const PINNED_APP = 'example';

/**
 * URL prefix -> URL, exactly as tools/dev/serve.mjs and the release tree mount them: the
 * library mounts are imported from tools/layout.mjs rather than restated, so the
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
 * `PINNED_APP`'s map, written out as the element the page carries.
 *
 * An element rather than bare JSON so that `tools/checks/verify-deps.mjs` finds it: it looks
 * for an import-map script element in this file's own text and compares what is inside
 * against `example/index.html`. Keeping the literal here is therefore not duplication for
 * its own sake — it is the copy that check exists to compare.
 *
 * The tag is deliberately not spelled out anywhere above: that search takes the first match
 * in the file, so a prose mention of it would be parsed as the map and fail as invalid JSON.
 */
const PINNED_MAP_ELEMENT = `<script type="importmap">
      {
        "imports": {
          "lit": "/lib/vendor/lit-all.min.js",
          "lit/async-directive.js": "/lib/vendor/lit-all.min.js",
          "lit/directives/repeat.js": "/lib/vendor/lit-all.min.js",
          "@preact/signals-core": "/lib/vendor/signals-core.mjs",
          "@core/": "/lib/core/",
          "@auth/": "/lib/auth/",
          "@host/": "/lib/host/",
          "@components/": "/components/"
        },
        "integrity": {
          "/remotes/billing/remote-entry.js": "sha384-E5eqKtGjo78yF0+SPoZq6Mzz7Rg8MEavpNn/qdAhXBzeujy57OZ12Xqp0SScrzWC",
          "/remotes/billing/billing-root.js": "sha384-BFpKJCch9q9lOTiabdlvbnstoOCrZt8N6AfA8L3djcZ6i+bD4fgFFTBie2gba6PT",
          "/remotes/analytics/remote-entry.js": "sha384-gikXl5fGQ0JSt91gbIGS5QeVey8/CZ/dOXzGvDIIuh350ltSRN/++0TlTFf+R13O",
          "/remotes/analytics/analytics-root.js": "sha384-UIHeDBMl71bh6r1rmjC4ki1XY9J0qJNqPtBbEVKB0xN+Z0pvrtCk7biIxz9k5rtn"
        }
      }
    </script>`;

/**
 * The import-map element the test page carries, for the application under test.
 *
 * For `PINNED_APP` it is the literal above. For any other application it is that
 * application's own map, read from its `index.html` — so a second application's remote pins
 * exist in exactly one place, its own document, and cannot drift from it. Two applications
 * cannot share one literal here: their remotes live at the same URLs with different digests,
 * and `/remotes/billing/remote-entry.js` cannot carry two hashes in one map.
 *
 * The vendored entries are dropped for the derived case, because the runner serves
 * `/lib/vendor` itself and the map's own pins are already asserted against those bytes by
 * `npm run vendor`. Remote artifacts keep theirs: the manifest validator requires a remote's
 * executable URL to be governed by the page's static map, and exercising that is part of what
 * an application's suite is for.
 *
 * @param {string} app
 * @returns {string}
 */
function importMapFor(app) {
  if (app === PINNED_APP) return PINNED_MAP_ELEMENT;

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
      for (const [from, to] of MOUNTS) {
        if (ctx.url === from || ctx.url.startsWith(from)) {
          ctx.url = to + ctx.url.slice(from.length);
          break;
        }
      }
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
