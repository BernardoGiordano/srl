import { token } from '@core/foundation/inject.js';

import { text } from './values.js';

/** @import { ApiClient } from '@core/http/client.js' */
/** @import { SelectItem } from '@components/data/ui-dynamic-filter.js' */

/**
 * Option lists for the filters.
 *
 * Three loading strategies over one API, because `ui-dynamic-filter` distinguishes
 * them and the distinction only matters when the lists have real sizes:
 *
 *   `options(name)`     a short list, fetched whole. Backs `observer` and `lazy`
 *                       rules — the difference between those two is *when* the
 *                       promise is created, which is the rule's business, not this
 *                       service's.
 *   `searchCities()`    one term at a time, never the list. 8,600 cities exist on
 *                       the server; nothing here ever holds them.
 *   `citiesByIds()`     labels for values restored from storage. Without it a
 *                       persisted city filter has no option to attach to and is
 *                       dropped on load, so the filter the user left switched on
 *                       quietly disappears.
 *
 * Short lists are memoised for the lifetime of the page. They are reference data —
 * statuses, channels, categories — so a second filter opening the same list should
 * not cost a second round trip, and this application has no screen where they change
 * while it is open.
 */

/** @type {import('@core/foundation/types.js').InjectionToken<LookupService>} */
export const LOOKUP_SERVICE = token('LookupService');

export class LookupService {
  #client;
  /** @type {Map<string, Promise<readonly SelectItem[]>>} */
  #cache = new Map();

  /** @param {ApiClient} client */
  constructor(client) {
    this.#client = client;
  }

  /**
   * @param {'status' | 'channel' | 'segment' | 'category' | 'role' | 'city' | 'country' | 'team' | 'location' | 'warehouse'} name
   * @returns {Promise<readonly SelectItem[]>}
   */
  options(name) {
    const cached = this.#cache.get(name);
    if (cached !== undefined) return cached;

    const pending = this.#fetchOptions(name)
      // A failed lookup is evicted rather than cached: retrying is what a user reopening
      // the filter expects, and a cached rejection makes the list permanently empty for the
      // rest of the session.
      .catch((cause) => {
        this.#cache.delete(name);
        throw cause;
      });

    this.#cache.set(name, pending);
    return pending;
  }

  /**
   * @param {string} name
   * @returns {Promise<readonly SelectItem[]>}
   */
  async #fetchOptions(name) {
    // The annotation is what binds the client's generic: without it the response is `any`
    // and every field read off it is unchecked. Declared as the shape this function needs
    // and no more, so the narrowing below is the only thing that turns it into options.
    /** @type {{ rows?: unknown }} */
    const body = await this.#client.get(`/lookups/${name}`);
    return toItems(body.rows);
  }

  /**
   * @param {string} term
   * @param {AbortSignal} [signal]
   * @returns {Promise<readonly SelectItem[]>}
   */
  async searchCities(term, signal) {
    /** @type {{ rows?: unknown }} */
    const body = await this.#client.get('/lookups/cities', { q: term, limit: 25 }, signal);
    return toCityItems(body.rows);
  }

  /**
   * @param {readonly unknown[]} ids
   * @returns {Promise<readonly SelectItem[]>}
   */
  async citiesByIds(ids) {
    const wanted = ids.map(text).filter((id) => id !== '');
    if (wanted.length === 0) return [];
    /** @type {{ rows?: unknown }} */
    const body = await this.#client.get('/lookups/cities', { id: wanted });
    return toCityItems(body.rows);
  }
}

/**
 * @param {unknown} rows
 * @returns {SelectItem[]}
 */
function toItems(rows) {
  if (!Array.isArray(rows)) return [];
  return /** @type {unknown[]} */ (rows).map((row) => {
    const entry = /** @type {{ value?: unknown, label?: unknown }} */ (row);
    const label = text(entry.label);
    return { value: entry.value, label: label === '' ? text(entry.value) : label };
  });
}

/**
 * A city's option value is its id, not its name: the id is what the API filters on and what
 * survives in preference storage, and two towns share a name often enough for the difference
 * to matter.
 *
 * @param {unknown} rows
 * @returns {SelectItem[]}
 */
function toCityItems(rows) {
  if (!Array.isArray(rows)) return [];
  return /** @type {unknown[]} */ (rows).map((row) => {
    const city = /** @type {{ id?: unknown, name?: unknown, region?: unknown }} */ (row);
    return {
      value: text(city.id),
      label: text(city.name),
      group: typeof city.region === 'string' ? city.region : undefined,
    };
  });
}
