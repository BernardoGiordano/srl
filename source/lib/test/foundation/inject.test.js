import { inject, provide, resetInjector, token } from '@core/foundation/inject.js';
import { assert } from '../harness.js';

describe('injector', () => {
  beforeEach(() => {
    resetInjector();
  });

  it('constructs lazily and returns the same instance thereafter', () => {
    /** @type {import('@core/foundation/types.js').InjectionToken<{ id: number }>} */
    const KEY = token('Thing');
    let constructed = 0;

    provide(KEY, () => {
      constructed += 1;
      return { id: constructed };
    });

    assert.equal(constructed, 0, 'must not construct until injected');
    const first = inject(KEY);
    const second = inject(KEY);
    assert.equal(constructed, 1);
    assert.equal(first, second);
  });

  it('lets a later provide() replace an already-built instance', () => {
    /** @type {import('@core/foundation/types.js').InjectionToken<string>} */
    const KEY = token('Greeting');

    provide(KEY, () => 'real');
    assert.equal(inject(KEY), 'real');

    // This is the seam tests use to swap in a fake.
    provide(KEY, () => 'fake');
    assert.equal(inject(KEY), 'fake');
  });

  it('names the token when no provider is registered', () => {
    /** @type {import('@core/foundation/types.js').InjectionToken<number>} */
    const KEY = token('MissingService');
    assert.throws(() => inject(KEY), 'No provider for MissingService');
  });

  it('reports a dependency cycle as a path rather than a stack overflow', () => {
    /** @type {import('@core/foundation/types.js').InjectionToken<number>} */
    const A = token('A');
    /** @type {import('@core/foundation/types.js').InjectionToken<number>} */
    const B = token('B');

    provide(A, () => inject(B) + 1);
    provide(B, () => inject(A) + 1);

    assert.throws(() => inject(A), 'Circular dependency: A -> B -> A');
  });
});
