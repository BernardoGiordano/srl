/**
 * What source delivery announces to the runtime: the checked-in
 * `app.manifest.json`, plus the template list the runtime has had no way to learn
 * while a developer works.
 *
 * The counterpart of `templateAnnouncement` in `build.mjs`, and here beside it for
 * that reason. Same manifest key, same runtime step, same `prefetchTemplates`; the
 * two differ only in where the list is read from — an artifact the build just
 * emitted, or `cli/project-model/` over the source on disk.
 *
 * WHY IT EXISTS
 *
 * `startApplication`'s third step warms the template cache from whichever key
 * `app.manifest.json` carries, and until now only a built artifact carried one.
 * `cli/delivery/build.mjs` writes `templateFiles` from what it emitted; the source
 * manifest a developer is served has no such key, so the step is skipped and every
 * template is discovered the slow way — a chunk's module body runs, learns its own
 * template URL, awaits it, and only then does the next module body run. Nine
 * components in a row is nine round trips in a row, on every reload. ADR-0081 was
 * bought for production and existed nowhere a developer works.
 *
 * WHAT IT IS NOT
 *
 * Not a development-only key, and not a second runtime path. The browser cannot
 * tell which module computed the list it was handed: the bundler reads it off the
 * artifact it just emitted, this reads it off `cli/project-model/`, and
 * `prefetchTemplates` is the same function either way. One list, two producers —
 * which is also what makes a delivery bug show up while editing rather than at
 * build. ADR-0085.
 *
 * THE REMOTE SPLIT
 *
 * A Remote's markup is announced on that Remote's own entry and nowhere else, the
 * way the build announces it (`templateAnnouncement(templateOutput,
 * publicationBase)`). The shell must not prefetch a Remote's templates: the router
 * runs the Remote's guard before `prepareRemote`, and a shell that had already
 * fetched the markup would have spent the request the guard exists to refuse. A
 * template is attributed to the Remote whose entry module it sits beside.
 *
 * WHEN IT DECLINES
 *
 * By returning null, which streams the file on disk unchanged — never by failing
 * the request. Three cases, and none of them should cost a developer their server:
 * the application configured `templateBundle` by hand, in which case the runtime
 * seeds from the bundle and a list beside it would be dead weight; the project
 * model threw, which mid-edit is an ordinary thing for a half-typed module to do;
 * or `typescript` is not installed, which is why the model is imported lazily and
 * a server that depends on this still starts on a fresh clone.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The publication base of one Remote entry — `/remotes/billing/` — or null for an
 * entry that names no root-absolute URL.
 *
 * Read off `url` rather than `mount`: `mount` is the route the Remote owns and
 * `url` is where its bytes are, and only the second says anything about where its
 * markup sits. The build enforces that the two agree with `/remotes/<name>/`
 * (`validateRemoteBase`); nothing here needs to, because a Remote served from
 * somewhere else simply claims the templates under wherever that is.
 *
 * @param {unknown} remote
 * @returns {string | null}
 */
function publicationBase(remote) {
  if (typeof remote !== 'object' || remote === null) return null;
  const url = /** @type {{ url?: unknown }} */ (remote).url;
  if (typeof url !== 'string' || !url.startsWith('/')) return null;
  const cut = url.lastIndexOf('/');
  return cut === -1 ? null : url.slice(0, cut + 1);
}

/**
 * The source manifest with `templateFiles` filled in, for the shell and for each
 * Remote.
 *
 * @param {Record<string, unknown>} source
 * @param {string[]} urls Every template URL the project ships, sorted.
 * @returns {Record<string, unknown>}
 */
function announce(source, urls) {
  const remotes = /** @type {unknown[]} */ (Array.isArray(source.remotes) ? source.remotes : []);
  const claimed = remotes.map((remote) => ({ remote, base: publicationBase(remote) }));

  /** @param {string} url */
  const isRemote = (url) => claimed.some(({ base }) => base !== null && url.startsWith(base));

  return {
    ...source,
    ...(claimed.length === 0
      ? {}
      : {
          remotes: claimed.map(({ remote, base }) =>
            base === null
              ? remote
              : {
                  .../** @type {Record<string, unknown>} */ (remote),
                  templateFiles: urls.filter((url) => url.startsWith(base)),
                },
          ),
        }),
    templateFiles: urls.filter((url) => !isRemote(url)),
  };
}

/**
 * The announcer for one application, ready to be an origin's `transform`.
 *
 * `file` is what a caller compares the resolved path against; `representation` is
 * what to send instead of the file's own bytes, or null to send those.
 *
 * It carries an `ETag` of its own because the origin's is built from the file on
 * disk and this body is not that file: the manifest a browser is handed is one the
 * project model contributed to, and stat cannot speak for the second half. Hashing
 * the bytes can — and it is the difference between the one generated document on
 * the page being a whole body on every reload and being a 304 like everything
 * else.
 *
 * The model is rebuilt per request rather than cached against a watcher. It costs
 * 5 ms warm — `cli/project-model/parse.mjs` caches each parse by path, size and
 * mtime, so a rebuild after one edit re-parses one file — and a cache with no
 * invalidation rule is the thing that would eventually announce a template a
 * developer deleted ten minutes ago. The first build is the expensive one, almost
 * all of it importing the TypeScript compiler, which is why `warm()` exists and
 * why a build in flight is shared rather than started twice.
 *
 * @param {{ name: string, dir: string }} app
 * @param {(format: string, ...values: string[]) => void} log
 * @returns {{
 *   file: string,
 *   representation: () => Promise<import('../origin/types.js').Representation | null>,
 *   warm: () => void,
 * }}
 */
export function templateAnnouncer(app, log) {
  const file = join(app.dir, 'app.manifest.json');

  /** @type {Promise<import('../origin/types.js').Representation | null> | null} */
  let building = null;
  /** Reported once per distinct cause: a syntax error mid-edit reloads on every keystroke. */
  let reported = '';

  const build = async () => {
    const source = /** @type {Record<string, unknown>} */ (
      JSON.parse(await readFile(file, 'utf8'))
    );
    // The runtime prefers a bundle over a list — seeding puts the markup in the
    // cache from bytes already in hand — so a list beside one is requests for
    // templates nothing will ever read from the network.
    if (typeof source.templateBundle === 'string') return null;

    const { readProject, shippedTemplates } = await import('../project-model/index.mjs');
    const model = await readProject(app);
    const urls = shippedTemplates(model)
      .map((template) => String(template.url))
      .sort((left, right) => left.localeCompare(right));

    const body = Buffer.from(`${JSON.stringify(announce(source, urls), null, 2)}\n`, 'utf8');
    const digest = createHash('sha256').update(body).digest('hex').slice(0, 16);
    return { body, headers: { ETag: `"${digest}"` } };
  };

  const start = () => {
    building ??= build()
      .catch((cause) => {
        const message = String(cause);
        if (message !== reported) {
          reported = message;
          log('  templates  not announced: %s', message);
        }
        return null;
      })
      .finally(() => {
        building = null;
      });
    return building;
  };

  return {
    file,
    representation: start,
    // Started and not awaited: the cold build is ~200 ms of importing a compiler,
    // and paying it while the developer is still reading the startup banner is
    // better than paying it inside the first manifest request.
    warm: () => {
      void start();
    },
  };
}
