import { effect, signal } from '@core/foundation/reactive.js';
import { resource } from '@core/foundation/resource.js';
import { assert } from '../harness.js';

/**
 * A promise a test settles by hand, plus the abort signal the loader was given.
 *
 * @template T
 */
class Deferred {
  /** @type {(value: T) => void} */
  resolve = () => {};

  /** @type {(cause: unknown) => void} */
  reject = () => {};

  /** @type {AbortSignal | undefined} */
  signal;

  /** @type {Promise<T>} */
  promise;

  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

/**
 * A loader that hands each call's deferred back to the test, in call order.
 *
 * @template T
 * @returns {{ load: (signal: AbortSignal) => Promise<T>, calls: Array<Deferred<T>> }}
 */
function loader() {
  /** @type {Array<Deferred<T>>} */
  const calls = [];
  return {
    calls,
    load: (signal) => {
      const call = /** @type {Deferred<T>} */ (new Deferred());
      call.signal = signal;
      calls.push(call);
      return call.promise;
    },
  };
}

describe('resource', () => {
  it('holds its initial value until the first request settles', async () => {
    const { load, calls } = /** @type {{ load: (signal: AbortSignal) => Promise<string>, calls: Array<Deferred<string>> }} */ (
      loader()
    );
    const read = resource(load, { initial: 'none' });

    assert.equal(read.value.value, 'none');

    // True before the first reload, because a screen's first paint happens before
    // its `onMount` and an empty state for one frame is a flicker.
    assert.ok(read.pending.value, 'pending until something settles');

    const settled = read.reload();
    assert.ok(read.pending.value, 'pending while in flight');
    assert.equal(read.value.value, 'none', 'the initial value survives the request');

    calls[0]?.resolve('rows');
    assert.equal(await settled, 'rows', 'reload resolves with the value');
    assert.equal(read.value.value, 'rows');
    assert.notOk(read.pending.value);
    assert.notOk(read.failed.value);
  });

  it('lets the latest request win, whichever order the responses arrive in', async () => {
    const { load, calls } = /** @type {{ load: (signal: AbortSignal) => Promise<string>, calls: Array<Deferred<string>> }} */ (
      loader()
    );
    const read = resource(load, { initial: 'none' });

    const first = read.reload();
    const second = read.reload();

    assert.equal(calls.length, 2);
    assert.ok(calls[0]?.signal?.aborted, 'the superseded request is aborted');
    assert.notOk(calls[1]?.signal?.aborted);

    // The stale response lands last, which is the race the twenty hand-written
    // copies existed to lose safely.
    calls[1]?.resolve('page two');
    calls[0]?.resolve('page one');

    assert.equal(await second, 'page two');
    assert.equal(await first, undefined, 'a superseded request resolves with undefined');
    assert.equal(read.value.value, 'page two', 'the stale response is dropped');
    assert.notOk(read.pending.value, 'the winner owns pending');
  });

  it('records a rejection as failed and keeps the last value', async () => {
    const { load, calls } = /** @type {{ load: (signal: AbortSignal) => Promise<string>, calls: Array<Deferred<string>> }} */ (
      loader()
    );
    const read = resource(load, { initial: 'none' });

    const first = read.reload();
    calls[0]?.resolve('rows');
    await first;

    const second = read.reload();
    assert.notOk(read.failed.value, 'a new request clears the flag before it can be read');
    calls[1]?.reject(new Error('500'));

    assert.equal(await second, undefined);
    assert.ok(read.failed.value);
    assert.notOk(read.pending.value);
    assert.equal(read.value.value, 'rows', 'a failed request does not blank the screen');

    const third = read.reload();
    assert.notOk(read.failed.value, 'retrying clears it');
    calls[2]?.resolve('rows again');
    await third;
    assert.notOk(read.failed.value);
  });

  it('ignores a rejection that arrives for a superseded request', async () => {
    const { load, calls } = /** @type {{ load: (signal: AbortSignal) => Promise<string>, calls: Array<Deferred<string>> }} */ (
      loader()
    );
    const read = resource(load, { initial: 'none' });

    const first = read.reload();
    const second = read.reload();

    // `fetch` rejects with AbortError when its signal aborts. That is not a
    // failure a screen should show: somebody asked a newer question.
    calls[0]?.reject(new DOMException('Aborted', 'AbortError'));
    calls[1]?.resolve('rows');

    assert.equal(await first, undefined);
    assert.equal(await second, 'rows');
    assert.notOk(read.failed.value, 'the abort is not a failure');
    assert.equal(read.value.value, 'rows');
  });

  it('aborts the in-flight request when the lifetime aborts, and writes nothing after', async () => {
    const { load, calls } = /** @type {{ load: (signal: AbortSignal) => Promise<string>, calls: Array<Deferred<string>> }} */ (
      loader()
    );
    const owner = new AbortController();
    const read = resource(load, { initial: 'none', lifetime: owner.signal });

    const settled = read.reload();
    owner.abort();
    assert.ok(calls[0]?.signal?.aborted, 'the loader sees the abort');

    calls[0]?.resolve('too late');
    assert.equal(await settled, undefined);
    assert.equal(read.value.value, 'none', 'nothing is written into a departed owner');
  });

  it('issues no request at all once the lifetime has aborted', async () => {
    const { load, calls } = /** @type {{ load: (signal: AbortSignal) => Promise<string>, calls: Array<Deferred<string>> }} */ (
      loader()
    );
    const owner = new AbortController();
    owner.abort();
    const read = resource(load, { initial: 'none', lifetime: owner.signal });

    assert.equal(await read.reload(), undefined);
    assert.equal(calls.length, 0, 'the loader is never called');
    assert.notOk(read.failed.value, 'a departed owner is not a failure to report');
  });

  it('reads a lifetime function once per request, so a re-attached owner still loads', async () => {
    const { load, calls } = /** @type {{ load: (signal: AbortSignal) => Promise<string>, calls: Array<Deferred<string>> }} */ (
      loader()
    );

    // What `() => this.lifetime` is for: SignalElement drops its controller on
    // disconnect and builds a new one on the next read, so a captured signal
    // would be permanently aborted after one DOM move.
    let owner = new AbortController();
    const read = resource(load, { initial: 'none', lifetime: () => owner.signal });

    const abandoned = read.reload();
    owner.abort();
    calls[0]?.resolve('first mount');
    assert.equal(await abandoned, undefined);

    owner = new AbortController();
    const settled = read.reload();
    assert.equal(calls.length, 2, 'the new lifetime is live, so the request goes out');
    calls[1]?.resolve('second mount');
    assert.equal(await settled, 'second mount');
    assert.equal(read.value.value, 'second mount');
  });

  it('runs the loader untracked, so reloading from an effect subscribes it to nothing new', async () => {
    const { load, calls } = /** @type {{ load: (signal: AbortSignal) => Promise<string>, calls: Array<Deferred<string>> }} */ (
      loader()
    );
    const trigger = signal(1);
    const readByTheLoader = signal('a');

    const read = resource(
      (signal) => {
        void readByTheLoader.value;
        return load(signal);
      },
      { initial: 'none' },
    );

    let runs = 0;
    const stop = effect(() => {
      void trigger.value;
      runs += 1;
      void read.reload();
    });

    assert.equal(runs, 1);
    assert.equal(calls.length, 1);

    // A detail screen's effect watches the route parameter. What the request reads on
    // its way out is not the screen's business, and must not re-run it.
    readByTheLoader.value = 'b';
    assert.equal(runs, 1, 'the effect is not subscribed to the loader\'s reads');

    trigger.value = 2;
    assert.equal(runs, 2, 'its own input still drives it');
    assert.equal(calls.length, 2);

    stop();
    calls[1]?.resolve('rows');
    await Promise.resolve();
  });
});
