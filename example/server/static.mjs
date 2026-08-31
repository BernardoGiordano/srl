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

import { join, resolve } from 'node:path';

import { templateAnnouncer } from '../../cli/delivery/source-manifest.mjs';
import { createOrigin } from '../../cli/origin/index.mjs';
import { MOUNTS } from '../../cli/package/interface.mjs';

/** @import { IncomingMessage, ServerResponse } from 'node:http' */

/**
 * The static handler for one application directory.
 *
 * A factory rather than a per-request function, because the announcer holds a
 * model build across requests and the first one is worth starting before the
 * server is listening rather than inside the page's second request.
 *
 * @param {string} directory
 * @returns {(request: IncomingMessage, response: ServerResponse) => Promise<void>}
 */
export function staticOrigin(directory) {
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

  const { handle } = createOrigin({
    mounts: /** @type {Array<[string, string]>} */ ([...MOUNTS, ['/', appDir]]),
    fallback: join(appDir, 'index.html'),
    headers: () => ({ 'Cache-Control': 'no-cache' }),
    transform: (file) => (file === manifest.file ? manifest.representation() : null),
  });

  return handle;
}
