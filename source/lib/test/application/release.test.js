import {
  releaseChanged,
  resetRelease,
  runningRelease,
  watchRelease,
} from '@core/application/release.js';
import { attachRouter, navigate } from '@core/navigation/router.js';
import { configureClock, createManualClock } from '@core/foundation/clock.js';
import { assert, mount, present, unmountAll } from '../harness.js';

/** @import { RouterAttachment } from '@core/navigation/router.js' */
/** @import { ManualClock } from '@core/foundation/types.js' */

class ReleaseView extends HTMLElement {}
customElements.define('test-release-view', ReleaseView);

/**
 * One `build.json`, in the shape `emitReleaseIdentity` writes.
 *
 * @param {string | null} commit
 * @param {{ app?: string, sourceDateEpoch?: number | null }} [rest]
 */
function identity(commit, rest = {}) {
  return {
    version: 1,
    app: rest.app ?? 'example',
    release: {
      commit,
      // `??` would turn an explicit null back into a date, and an artifact with
      // neither half set is the case one test below is entirely about.
      sourceDateEpoch: 'sourceDateEpoch' in rest ? rest.sourceDateEpoch : 1_756_000_000,
    },
    target: 'es2022',
  };
}

/**
 * Let the read a commit boundary started run to its conclusion.
 *
 * A read `watchRelease` starts is a promise nothing hands back — the whole point of
 * the interface is that the application binds a signal rather than awaiting a call.
 * Microtasks are enough to drain it because the fake below answers with a body
 * already in memory: every step between the request and the signal is a `then`
 * rather than a task, so this is a bounded drain and not a sleep.
 */
async function settleRead() {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

describe('release watch', () => {
  /** @type {RouterAttachment | null} */
  let app = null;
  /** @type {string} */
  let restoreUrl = '';
  /** @type {() => void} */
  let stop = () => {};
  /** @type {ManualClock} */
  let clock;
  /** @type {string[]} */
  let reads = [];
  /** @type {unknown[]} */
  let answers = [];

  /**
   * The HTTP seam, and the only thing this suite fakes. Each call takes the next
   * prepared answer and repeats the last one after that, so a test states how many
   * distinct releases the origin serves rather than how many times it is asked.
   *
   * @param {string} url
   * @returns {Promise<Response>}
   */
  function readBuildJson(url) {
    reads.push(url);
    const answer = answers.length > 1 ? answers.shift() : answers[0];
    if (answer === undefined) return Promise.reject(new Error('offline'));
    const response = new Response(null, { status: 200 });
    // A real `Response` — its status, its `ok`, its headers — whose body is already
    // parsed. Reading one through the stream would make settling a question of how
    // many tasks Chrome takes to drain a `ReadableStream`, which is a number no
    // assertion here should depend on.
    Object.defineProperty(response, 'json', { value: () => Promise.resolve(answer) });
    return Promise.resolve(response);
  }

  /** @param {{ minIntervalMs?: number }} [options] */
  async function startAt(options = {}) {
    const host = mount('<div><main></main></div>');
    history.replaceState(null, '', '/one');
    app = await attachRouter(host, [
      { path: '/one', component: 'test-release-view' },
      { path: '/two', component: 'test-release-view' },
    ]);
    stop = watchRelease({ fetch: readBuildJson, minIntervalMs: options.minIntervalMs ?? 60_000 });
    await settleRead();
    return present(app.outlet);
  }

  /** Navigate, then let the read that commit boundary started settle. */
  async function goTo(/** @type {string} */ href) {
    await navigate(href);
    await settleRead();
  }

  beforeEach(() => {
    restoreUrl = location.pathname + location.search;
    reads = [];
    answers = [];
    clock = createManualClock();
    configureClock({ clock });
    resetRelease();
  });

  afterEach(() => {
    stop();
    stop = () => {};
    app?.stop();
    app = null;
    configureClock();
    history.replaceState(null, '', restoreUrl);
    unmountAll();
  });

  it('reads the release the tab is running when the watch starts', async () => {
    answers = [identity('abc1234')];

    await startAt();

    assert.sameArray(reads, ['/build.json']);
    assert.equal(present(runningRelease.value).commit, 'abc1234');
    assert.equal(releaseChanged.value, false);
  });

  it('asks again at the next commit boundary once the interval has passed', async () => {
    answers = [identity('abc1234')];

    await startAt();
    clock.flush();
    await goTo('/two');

    assert.equal(reads.length, 2);
    assert.equal(releaseChanged.value, false, 'the same release is not a change');
  });

  it('reports a release the origin replaced', async () => {
    answers = [identity('abc1234'), identity('def5678')];

    await startAt();
    clock.flush();
    await goTo('/two');

    assert.equal(releaseChanged.value, true);
    assert.equal(
      present(runningRelease.value).commit,
      'abc1234',
      'the tab is still running what it loaded',
    );
  });

  it('stops asking once the answer is yes', async () => {
    answers = [identity('abc1234'), identity('def5678')];

    await startAt();
    clock.flush();
    await goTo('/two');
    const asked = reads.length;
    clock.flush();
    await goTo('/one');

    assert.equal(reads.length, asked, 'code cannot get less stale by being asked again');
  });

  it('makes one read per interval however many commits happen inside it', async () => {
    answers = [identity('abc1234')];

    await startAt();
    await goTo('/two');
    await goTo('/one');
    await goTo('/two');

    assert.equal(reads.length, 1);

    clock.flush();
    await goTo('/one');

    assert.equal(reads.length, 2);
  });

  it('reads a different application at this origin as a change', async () => {
    answers = [identity('abc1234'), identity('abc1234', { app: 'other' })];

    await startAt();
    clock.flush();
    await goTo('/two');

    assert.equal(releaseChanged.value, true);
  });

  it('takes a build of an uncommitted tree as no answer', async () => {
    answers = [identity(null, { sourceDateEpoch: null })];

    await startAt();
    clock.flush();
    await goTo('/two');

    assert.equal(runningRelease.value, null, 'two such builds are indistinguishable');
    assert.equal(releaseChanged.value, false);
  });

  it('ignores a document that is not a release identity', async () => {
    answers = [{ buildDate: '20260821-1442', gitCommit: 'fbe074a', app: 'example' }];

    await startAt();

    assert.equal(runningRelease.value, null);
    assert.equal(releaseChanged.value, false);
  });

  it('survives an origin that cannot be reached', async () => {
    answers = [];

    await startAt();
    clock.flush();
    answers = [identity('abc1234')];
    await goTo('/two');

    assert.equal(present(runningRelease.value).commit, 'abc1234', 'the next commit asks again');
  });

  it('asks nothing after it is stopped', async () => {
    answers = [identity('abc1234')];

    await startAt();
    stop();
    clock.flush();
    await goTo('/two');

    assert.equal(reads.length, 1);
  });
});
