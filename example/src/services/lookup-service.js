import { token } from '@core/foundation/inject.js';

import { text } from './values.js';

/** @import { ApiClient } from '@core/http/client.js' */
/** @import { SelectItem } from '@components/data/ui-dynamic-filter.js' */

/**
 * Load filter options. Short lists are cached for the page's lifetime. Cities are
 * searched on demand, and `citiesByIds()` restores labels for saved filters.
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
      // Evict failures so opening the filter again retries the request.
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
    // Declare only the response shape needed for the check below.
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
 * Use the city id as the value because names are not unique.
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
