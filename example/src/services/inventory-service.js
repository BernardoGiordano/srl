import { token } from '@core/foundation/inject.js';
import { ANY_COLUMN } from '@components/data/filter-descriptor.js';

import { textList } from './values.js';

/** @import { ApiClient } from '@core/http/client.js' */
/** @import { FilterState } from '@components/data/ui-dynamic-filter.js' */

/**
 * Products, stock movements and warehouses.
 *
 * The products endpoint takes an offset and a limit rather than a page and a page
 * size, because the products screen appends pages instead of replacing them and an
 * offset is what "append from here" means. `ui-table`'s `infinite` mode emits both
 * — `offset` alongside `page` — so the difference costs the page nothing.
 */

/** @type {import('@core/foundation/types.js').InjectionToken<InventoryService>} */
export const INVENTORY_SERVICE = token('InventoryService');

/**
 * @typedef {object} Product
 * @property {string} sku
 * @property {string} name
 * @property {string} category
 * @property {string} warehouse
 * @property {number} stock
 * @property {number} reorderPoint
 * @property {number} price
 * @property {string} updatedAt
 */

/**
 * @typedef {object} Movement
 * @property {string} id
 * @property {string} sku
 * @property {string} warehouse
 * @property {string} kind
 * @property {number} quantity
 * @property {string} at
 * @property {string} actor
 */

/**
 * @typedef {object} Warehouse
 * @property {string} id
 * @property {string} name
 * @property {string} city
 * @property {string} country
 * @property {number} capacity
 * @property {number} skus
 * @property {number} units
 * @property {number} alerts
 */

export class InventoryService {
  #client;

  /** @param {ApiClient} client */
  constructor(client) {
    this.#client = client;
  }

  /**
   * @param {{
   *   offset: number,
   *   limit: number,
   *   sort: { key: string, direction: 'asc' | 'desc' | '' },
   *   filters: readonly FilterState[],
   * }} query
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ rows: Product[], total: number, offset: number }>}
   */
  products(query, signal) {
    /** @type {Record<string, string | number | undefined | readonly string[]>} */
    const params = {
      offset: query.offset,
      limit: query.limit,
      sort: query.sort.key === '' ? undefined : query.sort.key,
      direction: query.sort.direction === '' ? undefined : query.sort.direction,
    };
    for (const filter of query.filters) {
      const values = textList(filter.value);
      if (values.length === 0) continue;
      if (filter.key === ANY_COLUMN) params.q = values[0];
      else if (filter.key === 'category' || filter.key === 'warehouse') params[filter.key] = values;
      else if (filter.key === 'belowReorder') params.belowReorder = values[0];
    }
    return this.#client.get('/products', params, signal);
  }

  /**
   * @param {number} limit
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ rows: Movement[], total: number }>}
   */
  movements(limit, signal) {
    return this.#client.get('/movements', { limit }, signal);
  }

  /**
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ rows: Warehouse[] }>}
   */
  warehouses(signal) {
    return this.#client.get('/warehouses', undefined, signal);
  }
}
