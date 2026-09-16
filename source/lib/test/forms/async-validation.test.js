import { fieldArray } from '@core/forms/array.js';
import { field } from '@core/forms/field.js';
import { group } from '@core/forms/group.js';
import { email, required } from '@core/forms/validators.js';
import { assert, instrumentedAbort } from '../harness.js';

/**
 * A rule whose answer is somewhere else.
 *
 * Everything here is about the four things the field owns and an application would
 * otherwise write per screen. The debounce, the supersession, the value it already has
 * an answer for, and the lifetime the request is bound to. The rule itself is a function
 * from a value to a code, which is what makes that possible.
 */

/** One macrotask, which is what a zero-millisecond debounce waits for. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A promise a test settles by hand, so supersession can be staged. */
function deferred() {
  /** @type {(code: string) => void} */
  let settle = () => {};
  /** @type {(reason: unknown) => void} */
  let fail = () => {};
  const promise = new Promise((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  return { promise, settle, fail };
}

describe('an asynchronous rule', () => {
  it('answers after the debounce, and the answer is an error like any other', async () => {
    const taken = field('', [required(), email()], {
      debounce: 0,
      async: [(value) => Promise.resolve(value === 'taken@example.com' ? 'taken' : '')],
    });

    taken.setValue('taken@example.com');
    assert.ok(taken.pending.value, 'pending from the keystroke, not from the request');
    assert.notOk(taken.valid.value, 'an unchecked value is not a valid one');

    await taken.whenSettled();
    assert.notOk(taken.pending.value);
    assert.equal(taken.error.value, 'taken');
    assert.notOk(taken.valid.value);

    taken.setValue('free@example.com');
    await taken.whenSettled();
    assert.equal(taken.error.value, '');
    assert.ok(taken.valid.value);
  });

  it('is not asked about a value a synchronous rule has already refused', async () => {
    let asked = 0;
    const address = field('', [required(), email()], {
      debounce: 0,
      async: [
        () => {
          asked += 1;
          return Promise.resolve('');
        },
      ],
    });

    address.setValue('not-an-address');
    await tick();
    assert.equal(asked, 0, 'a malformed address is not worth a round trip');
    assert.equal(address.error.value, 'malformed');

    address.setValue('real@example.com');
    await address.whenSettled();
    assert.equal(asked, 1);
  });

  it('is not asked about the value the field was built with, or one a reset installed', async () => {
    let asked = 0;
    const address = field('saved@example.com', [required(), email()], {
      debounce: 0,
      async: [
        () => {
          asked += 1;
          return Promise.resolve('taken');
        },
      ],
    });

    await tick();
    assert.equal(asked, 0, 'a form opened on a saved record would report its own address as taken');
    assert.ok(address.valid.value);

    address.setValue('other@example.com');
    await address.whenSettled();
    assert.equal(asked, 1);

    address.reset('third@example.com');
    await tick();
    assert.equal(asked, 1, "a reset carries the server's own answer");
    assert.equal(address.error.value, '', 'and the previous code went with it');
  });

  it('asks once for a value it already has an answer for', async () => {
    let asked = 0;
    const address = field('', [required()], {
      debounce: 0,
      async: [
        () => {
          asked += 1;
          return Promise.resolve('');
        },
      ],
    });

    address.setValue('a');
    await address.whenSettled();
    address.setValue('a');
    await tick();

    assert.equal(asked, 1, 'a control re-emitting an unchanged value asks nothing');
    assert.notOk(address.pending.value);
  });

  it('drops the answer to a check the next keystroke superseded', async () => {
    const first = deferred();
    const second = deferred();
    let call = 0;
    const address = field('', [required()], {
      debounce: 0,
      async: [
        () => {
          call += 1;
          return call === 1 ? first.promise : second.promise;
        },
      ],
    });

    address.setValue('a');
    await tick();
    address.setValue('ab');
    await tick();

    // The slow one comes back first and says the wrong thing about the wrong value.
    first.settle('taken');
    second.settle('');
    await address.whenSettled();

    assert.equal(address.error.value, '', 'the superseded answer is about a value nobody is holding');
    assert.ok(address.valid.value);
  });

  it('treats a check that could not run as having found nothing', async () => {
    const address = field('', [required()], {
      debounce: 0,
      async: [() => Promise.reject(new Error('offline'))],
    });

    address.setValue('a');
    await address.whenSettled();

    assert.equal(address.error.value, '', 'the write is what decides, not a failed lookup');
    assert.ok(address.valid.value);
  });

  it('binds the request to its owner and leaves no listener behind when it settles', async () => {
    const { controller, listeners } = instrumentedAbort();
    /** @type {AbortSignal | undefined} */
    let seen;
    const address = field('', [required()], {
      debounce: 0,
      lifetime: controller.signal,
      async: [
        (_value, signal) => {
          seen = signal;
          return Promise.resolve('');
        },
      ],
    });

    address.setValue('a');
    await address.whenSettled();

    assert.ok(seen !== undefined, 'the rule is handed the signal to pass to fetch');
    assert.equal(listeners.size, 0, 'a settled check keeps no listener on a lifetime that outlives it');
  });

  it('does not ask at all once the owner is gone', async () => {
    const controller = new AbortController();
    controller.abort();
    let asked = 0;
    const address = field('', [required()], {
      debounce: 0,
      lifetime: () => controller.signal,
      async: [
        () => {
          asked += 1;
          return Promise.resolve('taken');
        },
      ],
    });

    address.setValue('a');
    await address.whenSettled();

    assert.equal(asked, 0, 'not asking is the same answer as asking and dropping the response');
    assert.notOk(address.pending.value);
  });

  it('holds nothing up while the field is switched off', async () => {
    const pending = deferred();
    const address = field('', [required()], {
      debounce: 0,
      async: [() => pending.promise],
    });

    address.setValue('a');
    await tick();
    assert.ok(address.pending.value);

    address.setDisabled(true);
    assert.notOk(address.pending.value, 'a form saving must not wait on an answer it would ignore');
    assert.ok(address.valid.value);

    pending.settle('');
  });
});

describe('a form with an asynchronous rule under it', () => {
  const form = () =>
    group({
      name: field('', [required()]),
      address: field('', [required(), email()], {
        debounce: 0,
        async: [(value) => Promise.resolve(value === 'taken@example.com' ? 'taken' : '')],
      }),
    });

  it('is pending, and therefore not submittable, until the check comes back', async () => {
    const customer = form();
    customer.fields.name.setValue('Acme');
    customer.fields.address.setValue('free@example.com');

    assert.ok(customer.pending.value);
    assert.notOk(customer.markSubmitted(), 'the value is not known to be acceptable yet');

    await customer.whenSettled();
    assert.notOk(customer.pending.value);
    assert.ok(customer.markSubmitted());
  });

  it('refuses the submit and names the field once the check has answered', async () => {
    const customer = form();
    customer.fields.name.setValue('Acme');
    customer.fields.address.setValue('taken@example.com');

    await customer.whenSettled();
    assert.notOk(customer.markSubmitted());
    assert.equal(customer.invalidPath.value, 'address');
    assert.equal(customer.fields.address.visibleError.value, 'taken');
  });

  it('resolves immediately when there is nothing in flight', async () => {
    const customer = form();
    await customer.whenSettled();
    assert.notOk(customer.pending.value);
  });

  it('stops waiting on a row that was removed mid-check', async () => {
    const answer = deferred();
    const contact = () =>
      group({
        address: field('', [required()], { debounce: 0, async: [() => answer.promise] }),
      });
    const customer = group({ contacts: fieldArray(contact) });

    customer.fields.contacts.push().fields.address.setValue('free@example.com');
    await tick();
    assert.ok(customer.pending.value);
    assert.notOk(customer.markSubmitted());

    customer.fields.contacts.removeAt(0);
    await customer.whenSettled();
    assert.notOk(customer.pending.value, 'a row nobody holds cannot hold the submit up');
    assert.ok(customer.markSubmitted());

    // The answer arrives for a row that is gone, and reaches nothing that is left.
    answer.settle('taken');
    await tick();
    assert.ok(customer.markSubmitted());
  });
});

describe('an owner that ends while a check is out', () => {
  it('settles the field rather than waiting on a validator that ignores the abort', async () => {
    const controller = new AbortController();
    const answer = deferred();
    const address = field('', [required()], {
      debounce: 0,
      lifetime: controller.signal,
      async: [() => answer.promise],
    });

    address.setValue('a');
    await tick();
    assert.ok(address.pending.value);

    controller.abort();
    assert.notOk(address.pending.value, 'nothing is owed an answer once the owner is gone');

    // The validator never settles, and a submit that awaited this would never run.
    const waited = await Promise.race([
      address.whenSettled().then(() => 'settled'),
      tick().then(() => 'waiting'),
    ]);
    assert.equal(waited, 'settled', 'a waiting caller is released rather than left on a dead check');

    answer.settle('taken');
    await tick();
    assert.equal(address.error.value, '', 'a late answer is about a screen that has gone');
  });

  it('ends a check still waiting out its debounce', async () => {
    const controller = new AbortController();
    let asked = 0;
    const address = field('', [required()], {
      debounce: 20,
      lifetime: controller.signal,
      async: [
        () => {
          asked += 1;
          return Promise.resolve('taken');
        },
      ],
    });

    address.setValue('a');
    assert.ok(address.pending.value, 'pending from the keystroke, before the request');

    controller.abort();
    assert.notOk(address.pending.value);

    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(asked, 0, 'the quiet window belonged to the owner too');
  });

  it('holds no answer for the value it was asking about', async () => {
    let owner = new AbortController();
    const first = deferred();
    let asked = 0;
    const address = field('', [required()], {
      debounce: 0,
      lifetime: () => owner.signal,
      async: [
        () => {
          asked += 1;
          return asked === 1 ? first.promise : Promise.resolve('');
        },
      ],
    });

    address.setValue('a');
    await tick();
    owner.abort();
    assert.equal(asked, 1);

    // Re-attached, so a new lifetime and a value nobody ever got an answer for.
    owner = new AbortController();
    address.setValue('a');
    await address.whenSettled();

    assert.equal(asked, 2, 'an abandoned check leaves the value unchecked, not answered for');
  });

  it('leaves no listener on the lifetime it was bound to', async () => {
    const { controller, listeners } = instrumentedAbort();
    const answer = deferred();
    const address = field('', [required()], {
      debounce: 0,
      lifetime: controller.signal,
      async: [() => answer.promise],
    });

    address.setValue('a');
    await tick();
    assert.equal(listeners.size, 1, 'a check in flight is bound to its owner');

    controller.abort();
    assert.equal(listeners.size, 0);

    answer.settle('');
  });
});
