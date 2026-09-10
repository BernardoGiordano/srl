import { signal } from '@core/foundation/reactive.js';
import { OrderRecords } from '../src/state/order-records.js';
import { assert } from '../../source/lib/test/harness.js';

/** @import { Order } from '../src/services/sales-service.js' */

/**
 * @param {string} id
 * @param {string} status
 * @returns {Order & { customerDetail: null }}
 */
function order(id, status) {
  return {
    id,
    code: id,
    customerId: 'CU-1',
    customer: 'Customer',
    customerDetail: null,
    status,
    channel: 'direct',
    placedOn: '2026-09-10',
    promisedOn: '2026-09-11',
    currency: 'EUR',
    total: 10,
    owner: 'Owner',
    city: 'City',
    comuneId: 'C-1',
    comune: 'Comune',
  };
}

/** Let an immediately resolved loader publish through `resource()`. */
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('order records', () => {
  it('shares settled updates, follows ids, survives one release, and forgets the final one', async () => {
    const states = new Map([
      ['OR-1', order('OR-1', 'confirmed')],
      ['OR-2', order('OR-2', 'shipped')],
    ]);
    /** @type {string[]} */
    const reads = [];
    /** @type {string[]} */
    const writes = [];

    const records = new OrderRecords({
      order: (id) => {
        reads.push(id);
        return Promise.resolve(
          /** @type {ReturnType<typeof order>} */ (structuredClone(states.get(id))),
        );
      },
      setOrderStatus: (id, status) => {
        writes.push(`${id}:${status}`);
        const current = states.get(id);
        if (current === undefined) return Promise.reject(new Error(`No ${id}`));
        const next = { ...current, status };
        states.set(id, next);
        return Promise.resolve(next);
      },
    });

    const id = signal('OR-1');
    const layoutLifetime = new AbortController();
    const tabLifetime = new AbortController();
    const layout = records.watch(() => id.value, layoutLifetime.signal);
    const tab = records.watch(() => id.value, tabLifetime.signal);

    await settle();
    assert.sameArray(reads, ['OR-1'], 'two readers must start one read');
    assert.equal(layout.value.value?.status, 'confirmed');
    assert.equal(tab.value.value, layout.value.value, 'both readers must see one settled value');

    await layout.setStatus('shipped');
    assert.sameArray(writes, ['OR-1:shipped']);
    assert.sameArray(reads, ['OR-1', 'OR-1'], 'the write must refresh once');
    assert.equal(layout.value.value?.status, 'shipped');
    assert.equal(tab.value.value?.status, 'shipped', 'the other reader must receive the refresh');

    id.value = 'OR-2';
    await settle();
    assert.sameArray(reads, ['OR-1', 'OR-1', 'OR-2'], 'an id change must start one shared read');
    assert.equal(layout.value.value?.id, 'OR-2');
    assert.equal(tab.value.value?.id, 'OR-2');

    tabLifetime.abort();
    const returningTabLifetime = new AbortController();
    const returningTab = records.watch(() => id.value, returningTabLifetime.signal);
    await settle();
    assert.equal(reads.length, 3, 'a tab change must keep the layout-owned record settled');
    assert.equal(returningTab.value.value, layout.value.value);

    layoutLifetime.abort();
    returningTabLifetime.abort();

    const revisitLifetime = new AbortController();
    const revisit = records.watch(() => id.value, revisitLifetime.signal);
    await settle();
    assert.sameArray(reads, ['OR-1', 'OR-1', 'OR-2', 'OR-2'], 'a final release must drop the settled record');
    assert.equal(revisit.value.value?.id, 'OR-2');
    revisitLifetime.abort();
  });

  it('aborts an in-flight read only after its final reader leaves', () => {
    /** @type {AbortSignal[]} */
    const reads = [];
    const records = new OrderRecords({
      order: (_id, signal) => {
        reads.push(signal);
        return new Promise(() => {});
      },
      setOrderStatus: (id, status) => Promise.resolve(order(id, status)),
    });

    const firstLifetime = new AbortController();
    const secondLifetime = new AbortController();
    records.watch(() => 'OR-1', firstLifetime.signal);
    records.watch(() => 'OR-1', secondLifetime.signal);

    assert.equal(reads.length, 1);
    firstLifetime.abort();
    assert.notOk(reads[0]?.aborted, 'one remaining reader must keep the request alive');
    secondLifetime.abort();
    assert.ok(reads[0]?.aborted, 'the final release must abort the request');
  });

  it('refuses an already-ended owner rather than retaining an unreachable record', () => {
    const lifetime = new AbortController();
    lifetime.abort();
    const records = new OrderRecords({
      order: (id) => Promise.resolve(order(id, 'confirmed')),
      setOrderStatus: (id, status) => Promise.resolve(order(id, status)),
    });

    assert.throws(
      () => records.watch(() => 'OR-1', lifetime.signal),
      'already-aborted lifetime',
    );
  });
});
