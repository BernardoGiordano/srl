import { token } from '@core/foundation/inject.js';
import { ANY_COLUMN, RANGE_SEPARATOR } from '@components/data/filter-descriptor.js';

import { text, textList } from './values.js';

/** @import { ApiClient } from '@core/http/client.js' */
/** @import { FilterState } from '@components/data/ui-dynamic-filter.js' */

/**
 * Orders, customers and the dashboard summary.
 *
 * The interesting part of this file is `toOrderParams`. `ui-table` and
 * `ui-dynamic-filter` speak filter *descriptors*; the API speaks query parameters.
 * Something has to translate, and the choice of where is a real one:
 *
 *   - in the page: every screen over this resource repeats it;
 *   - in the components: they would have to know one application's API shape;
 *   - here: the descriptor vocabulary is a framework contract, the parameter names
 *     are this API's, and a service is exactly the seam between the two.
 *
 * So the page stays five lines of query handling, and adding a filter rule is a
 * declaration plus one case below.
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
 * One person at a customer. Three strings, no id: a contact has no identity of its
 * own on this API — the list is written whole with the customer, so a row is
 * addressed by its position and nothing else needs to name it.
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
 * What a client may write. `id` and `openOrders` are absent because the server owns
 * both, and a shape that could carry them is a shape a screen will eventually send.
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
 * The shape `ui-table` emits on `query-change`, narrowed to what this service uses.
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
   * Needs `sales:write`. The server answers 403 without it, which is what the
   * detail screen shows rather than hiding the control: a disabled button with a
   * reason is more useful than a missing one.
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
   * @param {CustomerInput} input
   * @returns {Promise<Customer>}
   */
  createCustomer(input) {
    return this.#client.post('/customers', input);
  }

  /**
   * The whole record, not a diff: this API replaces the writable fields it is given,
   * and a form that edits all of them has nothing to diff against anyway. A screen
   * that edited one field of many would be the reason to send less.
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
 * Descriptors in, query parameters out.
 *
 * Every rule the orders screen declares appears here once. A descriptor with a key
 * this function does not know is dropped rather than guessed at: sending an unknown
 * parameter to a server that ignores it produces a filter that silently does
 * nothing, which is worse than one that visibly does not exist.
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
      // The typeahead's ref. Its values are municipality ids, which is what the
      // options carry and what the API filters on.
      case 'comuneId':
        params.comune = values;
        break;
      case 'placedOn': {
        // A `daterange` rule stores one half-open interval, `since to until`, with
        // `until` exclusive. The API takes the same halves under their own names
        // rather than parsing the joined string a second time.
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
