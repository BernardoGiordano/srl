import { schedule } from '@core/foundation/clock.js';
import { readJson } from '@core/foundation/json.js';
import { effect, signal } from '@core/foundation/reactive.js';
import { isNavigating } from '@core/navigation/router.js';

/**
 * Tracks which release the tab is running and whether the origin has moved on.
 * ADR-0089.
 *
 * Every artifact emits `build.json` with its application name, commit and build date. A
 * tab left open across a deploy keeps running old chunks until one of them 404s. The
 * generated service worker doesn't `skipWaiting`, so the tab needs this fact to react.
 *
 * This module decides when the fact is true. The application decides what to show and
 * whether to reload, since a forced reload can destroy unsaved work.
 *
 * The check runs at commit boundaries, when `isNavigating` falls back to `false`. That
 * is when the DOM changes (ADR-0002) and when the application can act. Checks are
 * throttled, so a busy minute costs one request.
 *
 * A release is identified by the application name, commit and source date. A build of
 * an uncommitted tree has no commit or date, so such a document gives no answer. Once a
 * change is detected it stays detected, and the watch stops.
 */

/** @import { ReadonlySignal } from '@core/foundation/types.js' */
/** @import { ReleaseIdentity, ReleaseWatchOptions } from '@core/application/types.js' */

const running = signal(/** @type {ReleaseIdentity | null} */ (null));

const moved = signal(false);

/**
 * The release this tab is running, taken from the first `build.json` answer. Null until
 * that answer arrives, and null on an origin that publishes no identity.
 *
 * @type {ReadonlySignal<ReleaseIdentity | null>}
 */
export const runningRelease = running;

/**
 * Whether the origin serves a different release than this tab runs. It starts false and
 * stays true once set. A banner binds to this.
 *
 * @type {ReadonlySignal<boolean>}
 */
export const releaseChanged = moved;

/**
 * Start asking, at every commit boundary, whether the origin has moved on.
 *
 * @param {ReleaseWatchOptions} [options]
 * @returns {() => void} stops the watch; safe to call twice
 */
export function watchRelease(options = {}) {
  const { url = '/build.json', minIntervalMs = 60_000 } = options;
  const request = options.fetch ?? ((/** @type {string} */ at) => globalThis.fetch(at));

  let stopped = false;
  let asking = false;
  // A flag cleared by `schedule` throttles the checks, so a test's manual clock drives it
  // without real sleeps. ADR-0079.
  let cooling = false;
  // `effect` runs once synchronously and `stop` closes over this, so it's declared
  // before that call.
  /** @type {() => void} */
  let dispose = () => {};

  const stop = () => {
    stopped = true;
    dispose();
  };

  const ask = async () => {
    if (stopped || asking || cooling) return;
    asking = true;
    cooling = true;
    schedule(() => {
      cooling = false;
    }, minIntervalMs);
    try {
      // `no-cache` matches how the file is served. A stale read would report the release
      // the tab already knows.
      const response = await request(url, { cache: 'no-cache' });
      if (!response.ok || stopped) return;
      const next = identityOf(await readJson(response));
      if (next === null || stopped) return;
      const current = running.peek();
      if (current === null) {
        running.value = next;
        return;
      }
      if (!isSameRelease(current, next)) {
        moved.value = true;
        stop();
      }
    } catch {
      // Offline, or the origin is mid-deploy. The next commit asks again.
    } finally {
      asking = false;
    }
  };

  // The first run sees `isNavigating` false and records the running release.
  dispose = effect(() => {
    if (!isNavigating.value) void ask();
  });

  return stop;
}

/**
 * Forget the release this tab is running. For tests, since the signals are module
 * state.
 *
 * @internal
 */
export function resetRelease() {
  running.value = null;
  moved.value = false;
}

/**
 * The identity in one `build.json` document, or null when it has none.
 *
 * Narrowed by hand, because a misconfigured origin may answer with its index page.
 *
 * @param {unknown} value
 * @returns {ReleaseIdentity | null}
 */
function identityOf(value) {
  if (typeof value !== 'object' || value === null) return null;
  const document = /** @type {Record<string, unknown>} */ (value);
  if (document.version !== 1 || typeof document.app !== 'string') return null;
  const release = document.release;
  if (typeof release !== 'object' || release === null) return null;
  const { commit, sourceDateEpoch } = /** @type {Record<string, unknown>} */ (release);
  const identity = {
    app: document.app,
    commit: typeof commit === 'string' ? commit : null,
    sourceDateEpoch: typeof sourceDateEpoch === 'number' ? sourceDateEpoch : null,
  };
  // With neither commit nor date, the build came from an uncommitted tree and can't be
  // compared.
  return identity.commit === null && identity.sourceDateEpoch === null ? null : identity;
}

/**
 * @param {ReleaseIdentity} left
 * @param {ReleaseIdentity} right
 */
function isSameRelease(left, right) {
  return (
    left.app === right.app &&
    left.commit === right.commit &&
    left.sourceDateEpoch === right.sourceDateEpoch
  );
}
