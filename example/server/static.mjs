/**
 * The static half of this application's server: the same three mounts the dev
 * server and the deployment serve.
 *
 *   /             example/            this application
 *   /lib/         source/lib/         the framework
 *   /components/  source/components/  the shared collection
 *
 * The rules are not restated here — `cli/origin/` owns them, and this is one more
 * adapter over it beside `cli/dev/serve.mjs`, the benchmark origin and the
 * artifact test origin (ADR-0075). It used to be a fifth implementation of the
 * mount walk, the traversal refusal, the history fallback and the content type,
 * agreeing with the other four by hand: the copy that mattered most, because it is
 * the server `npm run example:serve` starts and so the one a developer of this
 * application is actually looking at. ADR-0085.
 *
 * What this adapter states, and nothing else:
 *
 *   templates     `app.manifest.json` announced with `templateFiles`, computed
 *                 from `cli/project-model/` — the same key the build writes from
 *                 the artifact it emitted, read by the same startup step. Without
 *                 it a chunk's nine components cost nine round trips in a row,
 *                 because each module body learns its own template URL only once
 *                 it runs. ADR-0081 in development.
 *   revalidation  `no-cache` rather than `no-store`, so a reload revalidates
 *                 against the `ETag` the origin sends and gets 304s for every file
 *                 the developer did not touch. `no-store` deleted the browser
 *                 cache outright, which made the second reload cost exactly what
 *                 the first did.
 *   updates       the same development update session `npm start` runs, over this
 *                 application's own mounts, so an `.html` edit is re-rendered into
 *                 the page here too. `cli/dev/updates.mjs`. This half only ever runs
 *                 in development — `--api-only` never imports this module — and the
 *                 session is what makes the two servers one behaviour rather than
 *                 two, which is the same argument the mount table already won.
 *
 * Why this application serves its own files at all, rather than `npm start` doing
 * it: the API, the auth cookie and the event stream must be same-origin with the
 * page. `SameSite=Strict` on the session cookie, `grants.api` comparing a remote's
 * request against a pathname, and `EventSource` inheriting the cookie all stop
 * working the moment the API is on a second port. One origin is the requirement;
 * one process is the simplest way to have it.
 *
 * `--api-only` never imports this module, which is why importing `cli/` here is
 * safe: the deployment that omits that directory is the deployment where nginx
 * serves the files and this half does not run.
 */

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { templateAnnouncer } from '../../cli/delivery/source-manifest.mjs';
import { startUpdateSession } from '../../cli/dev/updates.mjs';
import { createOrigin } from '../../cli/origin/index.mjs';
import { MOUNTS } from '../../cli/package/interface.mjs';

/** @import { IncomingMessage, ServerResponse } from 'node:http' */

/**
 * The static handler for one application directory, and the call that stops what it
 * started.
 *
 * A factory rather than a per-request function, because the announcer holds a
 * model build across requests and the first one is worth starting before the
 * server is listening rather than inside the page's second request. It hands back a
 * `close` for the same reason the dev server does: an update session holds recursive
 * watches and open event streams, and a process that ends without releasing them
 * waits for a subscriber that will never disconnect on its own.
 *
 * @param {string} directory
 * @param {{ watch?: boolean }} [options]
 * @returns {{ handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>, close: () => Promise<void> }}
 */
export function staticOrigin(directory, options = {}) {
  // `resolve` and not the argument as given: server.mjs builds it from a URL, so it
  // arrives with a trailing separator, and the project model compares directory
  // prefixes to decide which URL a template file is served at — `<dir>/` + `/` is a
  // prefix nothing matches, which silently announces only the mounted library's
  // templates and none of the application's own.
  const appDir = resolve(directory);

  const manifest = templateAnnouncer({ name: 'example', dir: appDir }, (format, ...values) => {
    console.warn(`[example]${format}`, ...values);
  });
  manifest.warm();

  const mounts = /** @type {Array<[string, string]>} */ ([...MOUNTS, ['/', appDir]]);
  const entryDocument = join(appDir, 'index.html');

  const updates = (options.watch ?? true)
    ? startUpdateSession({
        mounts,
        log: (format, ...values) => {
          console.log(`[example]${format}`, ...values);
        },
      })
    : null;

  const { handle } = createOrigin({
    mounts,
    fallback: entryDocument,
    headers: () => ({ 'Cache-Control': 'no-cache' }),
    transform: async (file) => {
      if (file === manifest.file) return manifest.representation();
      if (updates === null || file !== entryDocument) return null;
      return { body: Buffer.from(updates.inject(await readFile(file, 'utf8')), 'utf8') };
    },
    route: (request, response, url) =>
      updates === null ? false : updates.route(request, response, url),
  });

  return { handle, close: async () => updates?.close() };
}
