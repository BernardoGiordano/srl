import { token } from '@core/foundation/inject.js';
import { ANY_COLUMN, RANGE_SEPARATOR } from '@components/data/filter-descriptor.js';

import { text, textList } from './values.js';

/** @import { ApiClient } from '@core/http/client.js' */
/** @import { FilterState } from '@components/data/ui-dynamic-filter.js' */

/**
 * Load orders, customers, and the dashboard summary. `toOrderParams` translates
 * table filter descriptors into this API's query parameters.
 */

/** @type {import('@core/foundation/types.js').InjectionToken<SalesService>} */
export const SALES_SERVICE = token('SalesService');

/**
 * @typedef {object} Order
 * @property {string} id
 * @property {string} code
 * @property {string} customerId
 * @property {string} customer
 * @property {string} status
 * @property {string} channel
 * @property {string} placedOn
 * @property {string} promisedOn
 * @property {string} currency
 * @property {number} total
 * @property {string} owner
 * @property {string} city
 * @property {string} comuneId
 * @property {string} comune
 */

/**
 * A contact has no id because the API writes the whole list with its customer.
 *
 * @typedef {object} CustomerContact
 * @property {string} name
 * @property {string} email
 * @property {string} role
 */

/**
 * @typedef {object} Customer
 * @property {string} id
 * @property {string} name
 * @property {string} email
 * @property {string} segment
 * @property {string} city
 * @property {string} country
 * @property {string} since
 * @property {number} openOrders
 * @property {number} revenue
 * @property {string} owner
 * @property {string} notes
 * @property {readonly CustomerContact[]} contacts
 */

/**
 * Writable customer fields. The server owns `id` and `openOrders`.
 *
 * @typedef {object} CustomerInput
 * @property {string} name
 * @property {string} email
 * @property {string} segment
 * @property {string} city
 * @property {string} country
 * @property {string} since
 * @property {number} revenue
 * @property {string} owner
 * @property {string} notes
 * @property {readonly CustomerContact[]} contacts
 */

/**
 * @typedef {object} OrderLine
 * @property {number} line
 * @property {string} sku
 * @property {string} name
 * @property {number} quantity
 * @property {number} unitPrice
 * @property {number} total
 */

/**
 * @typedef {object} OrderEvent
 * @property {string} at
 * @property {string} actor
 * @property {string} event
 * @property {string} detail
 */

/**
 * @typedef {object} DashboardSummary
 * @property {string} generatedAt
 * @property {ReadonlyArray<{ key: string, value: number, delta: number, currency: string }>} kpis
 * @property {ReadonlyArray<{ key: string, sku: string, name: string, stock: number, reorderPoint: number }>} alerts
 * @property {{ quarter: { attained: number, currency: string, value: number } }} targets
 */

/**
 * The fields this service uses from `ui-table`'s `query-change` event.
 *
 * @typedef {object} TableQuery
 * @property {number} page
 * @property {number} pageSize
 * @property {number} [offset]
 * @property {{ key: string, direction: 'asc' | 'desc' | '' }} sort
 * @property {readonly FilterState[]} filters
 */

export class SalesService {
  #client;

  /** @param {ApiClient} client */
  constructor(client) {
    this.#client = client;
  }

  /**
   * @param {TableQuery} query
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ rows: Order[], total: number }>}
   */
  searchOrders(query, signal) {
    return this.#client.get('/orders', toOrderParams(query), signal);
  }

  /**
   * @param {string} id
   * @param {AbortSignal} [signal]
   * @returns {Promise<Order & { customerDetail: Customer | null }>}
   */
  order(id, signal) {
    return this.#client.get(`/orders/${encodeURIComponent(id)}`, undefined, signal);
  }

  /**
   * @param {string} id
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ rows: OrderLine[] }>}
   */
  orderLines(id, signal) {
    return this.#client.get(`/orders/${encodeURIComponent(id)}/lines`, undefined, signal);
  }

  /**
   * @param {string} id
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ rows: OrderEvent[] }>}
   */
  orderHistory(id, signal) {
    return this.#client.get(`/orders/${encodeURIComponent(id)}/history`, undefined, signal);
  }

  /**
   * Change an order status. The server requires `sales:write`.
   *
   * @param {string} id
   * @param {string} status
   * @returns {Promise<Order>}
   */
  setOrderStatus(id, status) {
    return this.#client.patch(`/orders/${encodeURIComponent(id)}`, { status });
  }

  /**
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ rows: Customer[], total: number }>}
   */
  customers(signal) {
    return this.#client.get('/customers', undefined, signal);
  }

  /**
   * @param {string} id
   * @param {AbortSignal} [signal]
   * @returns {Promise<Customer>}
   */
  customer(id, signal) {
    return this.#client.get(`/customers/${encodeURIComponent(id)}`, undefined, signal);
  }

  /**
   * Check whether another customer uses this email. The field owns cancellation.
   *
   * @param {string} email
   * @param {string} exclude The customer being edited, which does not clash with itself.
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ taken: boolean }>}
   */
  emailAvailable(email, exclude, signal) {
    // Omit `exclude` when creating a customer.
    const query = { email, exclude: exclude === '' ? undefined : exclude };
    return this.#client.get('/customers/email-available', query, signal);
  }

  /**
   * @param {CustomerInput} input
   * @returns {Promise<Customer>}
   */
  createCustomer(input) {
    return this.#client.post('/customers', input);
  }

  /**
   * Replace all writable customer fields.
   *
   * @param {string} id
   * @param {CustomerInput} input
   * @returns {Promise<Customer>}
   */
  updateCustomer(id, input) {
    return this.#client.patch(`/customers/${encodeURIComponent(id)}`, input);
  }

  /**
   * @param {AbortSignal} [signal]
   * @returns {Promise<DashboardSummary>}
   */
  dashboard(signal) {
    return this.#client.get('/dashboard/summary', undefined, signal);
  }
}

/**
 * Translate known order filters into query parameters. Unknown keys are omitted.
 *
 * @param {TableQuery} query
 * @returns {Record<string, string | number | undefined | readonly string[]>}
 */
export function toOrderParams(query) {
  /** @type {Record<string, string | number | undefined | readonly string[]>} */
  const params = {
    page: query.page,
    pageSize: query.pageSize,
    sort: query.sort.key === '' ? undefined : query.sort.key,
    direction: query.sort.direction === '' ? undefined : query.sort.direction,
  };

  for (const filter of query.filters) {
    const key = filter.key;
    const values = textList(filter.value);
    if (values.length === 0) continue;

    switch (key) {
      case ANY_COLUMN:
        params.q = values[0];
        break;
      case 'status':
      case 'channel':
      case 'city':
      case 'customerId':
        params[key] = values;
        break;
      // Typeahead values are municipality ids.
      case 'comuneId':
        params.comune = values;
        break;
      case 'placedOn': {
        // Keep the date range's exclusive upper bound for the API.
        const [since, until] = text(values[0]).split(RANGE_SEPARATOR);
        if (since !== undefined && since !== '') params.placedFrom = since;
        if (until !== undefined && until !== '') params.placedUntil = until;
        break;
      }
      default:
        break;
    }
  }

  return params;
}
