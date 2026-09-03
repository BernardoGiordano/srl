import { schedule } from '@core/foundation/clock.js';
import { readJson } from '@core/foundation/json.js';
import { effect, signal } from '@core/foundation/reactive.js';
import { isNavigating } from '@core/navigation/router.js';

/**
 * Which release the tab is running, and whether the origin has moved on.
 *
 * Every artifact this toolchain builds emits `build.json` — the application's name,
 * the commit it was built from, the source date — at a URL that never changes and a
 * cache policy that says to check it. Nothing read it. The cost of that is specific
 * and it is the workload this library is for: an internal tool left open across a
 * deploy keeps running last week's chunks until one of them 404s, and the first thing
 * the user sees is a route that will not load.
 *
 * A worker does not fix it. The generated one deliberately does not `skipWaiting`
 * (`@srljs/cli`'s `service-worker.mjs`), because swapping the code under a running
 * tab is the same failure with better caching. What is missing is not a mechanism but
 * a fact: the tab has no way to know.
 *
 * WHAT THIS OWNS, AND WHAT IT DOES NOT
 *
 * It owns *when the fact is true*: the file, the comparison, and the instant it is
 * safe to ask. The application owns everything after that — whether a banner appears,
 * what it says, whether it offers a reload or forces one after an idle minute. A
 * library that reloaded the page would be taking a decision that destroys unsaved
 * work in a form the user was halfway through.
 *
 * WHY A COMMIT BOUNDARY IS THE INSTANT
 *
 * A navigation is one transaction with exactly one moment when the DOM changes
 * (ADR-0002), and `isNavigating` falling back to false is that moment observed from
 * outside the router. It is also the only moment worth asking at: a release the tab
 * learns about mid-navigation is a release it can do nothing with until the screen
 * settles, and a poll on a timer asks the same question while the user is reading.
 * So the check rides the navigations the user is already making, throttled so a
 * click-heavy minute is one request rather than forty.
 *
 * WHAT MAKES A RELEASE DIFFERENT
 *
 * The name and both halves of the identity. A build of an uncommitted tree carries
 * `null` for both halves on purpose — `ArtifactRelease` says so — which makes two
 * such builds indistinguishable, so a document with no identity is read as "no
 * answer" rather than as "unchanged". A development origin serving something else
 * entirely at that URL reaches the same conclusion by the same rule.
 *
 * Once the answer is yes it stays yes, and the watch stops. Code cannot get less
 * stale by being asked again, and an application that dismissed the banner has not
 * changed which chunks the tab is running.
 *
 * ADR-0089.
 */

/** @import { ReadonlySignal } from '@core/foundation/types.js' */
/** @import { ReleaseIdentity, ReleaseWatchOptions } from '@core/application/types.js' */

const running = signal(/** @type {ReleaseIdentity | null} */ (null));

const moved = signal(false);

/**
 * The release this tab is running: the first identity `build.json` answered with,
 * which is the one the loaded chunks came from. Null until the first answer arrives,
 * and null forever on an origin that publishes no identity.
 *
 * @type {ReadonlySignal<ReleaseIdentity | null>}
 */
export const runningRelease = running;

/**
 * Whether the origin is serving a different release than this tab is running. False
 * until proven otherwise, and true from then on.
 *
 * This is the whole interface a banner binds to. It says the code is stale; it does
 * not say what to do about it.
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
  // Throttling by a flag a scheduled callback clears, rather than by comparing
  // timestamps: `schedule` is the one seam the library has on the wall clock, and a
  // suite that drove this with a manual clock would otherwise have to sleep past a
  // real minute to see the second request. ADR-0079.
  let cooling = false;
  // Assigned by `effect` below, and named here because `stop` closes over it: the
  // effect's first run happens inside that call, so a `const` declared after it
  // would be in its temporal dead zone for the one path that reaches `stop`
  // synchronously.
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
      // `no-cache` is the same instruction the file is served with. A stale-while-
      // revalidate read here would answer with the release the tab already knows.
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
      // Offline, or the origin mid-swap. The next commit asks again, which is what
      // makes this a watch rather than a probe that has to succeed.
    } finally {
      asking = false;
    }
  };

  // Runs once on subscribe, with `isNavigating` false: that first read is what
  // establishes which release the tab is running, before any navigation can change
  // the answer.
  dispose = effect(() => {
    if (!isNavigating.value) void ask();
  });

  return stop;
}

/**
 * Forget the release this tab is running.
 *
 * Exported for tests: the two signals are module state, and a suite that asserted a
 * change would otherwise leave the next one comparing against a release it never set.
 *
 * @internal
 */
export function resetRelease() {
  running.value = null;
  moved.value = false;
}

/**
 * The identity in one `build.json` document, or null when it carries none.
 *
 * Narrowed by hand rather than asserted, because this crosses a trust boundary in the
 * one direction that matters: the file is small, unversioned in the URL sense, and
 * the first thing a misconfigured origin answers with is its own index page.
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
  // Neither half set is a build of an uncommitted tree, which is a legitimate
  // artifact and an identity nothing can compare. Reporting it would make every
  // subsequent read a "change" or a "no change" by accident.
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
