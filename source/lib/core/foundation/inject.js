/**
 * Dependency injection, root scope only.
 *
 * Angular's `inject()` minus hierarchical injectors, which enterprise apps
 * reach for far less often than the framework's prominence suggests. Services
 * are lazily constructed singletons keyed by a typed token.
 *
 * The reason to have this at all rather than importing service modules directly:
 * tests need to swap a service for a fake, and a direct `import` gives no seam
 * to do it through. `provide()` in a `beforeEach` is that seam.
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
 * Register how to build the value for a token. Registering twice replaces the
 * provider and discards any instance already built, which is what makes test
 * overrides work.
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
 * Drop every provider and instance. For test isolation.
 *
 * @internal
 */
export function resetInjector() {
  providers.clear();
  instances.clear();
  constructing.clear();
}
