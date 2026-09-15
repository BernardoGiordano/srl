/**
 * Dependency injection with a single root scope.
 *
 * It works like Angular's `inject()` without hierarchical injectors. Services are lazily
 * built singletons keyed by typed tokens. A test swaps a service by calling `provide()`
 * in a `beforeEach`, which a direct import can't offer.
 *
 *     export const USER_SERVICE = token('UserService');
 *     provide(USER_SERVICE, () => new UserService(apiBaseUrl));
 *
 *     const users = inject(USER_SERVICE);   // typed as UserService
 */

/** @import { InjectionToken, Provider } from '@core/foundation/types.js' */

/** @type {Map<InjectionToken<unknown>, Provider<unknown>>} */
const providers = new Map();

/** @type {Map<InjectionToken<unknown>, unknown>} */
const instances = new Map();

/** Tokens currently being constructed, for cycle detection. */
/** @type {Set<InjectionToken<unknown>>} */
const constructing = new Set();

/**
 * Create a typed injection token.
 *
 * @template T
 * @param {string} description Shown in error messages. Use the service name.
 * @returns {InjectionToken<T>}
 */
export function token(description) {
  return { description };
}

/**
 * Register how to build a token's value. Registering again replaces the provider and
 * discards any built instance, which is how test overrides work.
 *
 * @template T
 * @param {InjectionToken<T>} key
 * @param {Provider<T>} provider
 */
export function provide(key, provider) {
  providers.set(key, provider);
  instances.delete(key);
}

/**
 * Resolve a token to its singleton instance, constructing it on first use.
 *
 * @template T
 * @param {InjectionToken<T>} key
 * @returns {T}
 */
export function inject(key) {
  if (instances.has(key)) {
    return /** @type {T} */ (instances.get(key));
  }

  const provider = providers.get(key);
  if (provider === undefined) {
    throw new Error(
      `No provider for ${key.description}. Call provide(${key.description}, ...) ` +
        `during startup, or in a beforeEach for tests.`,
    );
  }

  if (constructing.has(key)) {
    const cycle = [...constructing, key].map((t) => t.description).join(' -> ');
    throw new Error(`Circular dependency: ${cycle}`);
  }

  constructing.add(key);
  try {
    const instance = provider();
    instances.set(key, instance);
    return /** @type {T} */ (instance);
  } finally {
    constructing.delete(key);
  }
}

/**
 * Drop every provider and instance, for test isolation.
 *
 * @internal
 */
export function resetInjector() {
  providers.clear();
  instances.clear();
  constructing.clear();
}
