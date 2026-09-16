import { token } from '@core/foundation/inject.js';

/** @import { ApiClient } from '@core/http/client.js' */

/**
 * Load the small HR roster in one request. The table sorts, filters, and pages
 * these rows locally.
 */

/** @type {import('@core/foundation/types.js').InjectionToken<PeopleService>} */
export const PEOPLE_SERVICE = token('PeopleService');

/**
 * @typedef {object} Employee
 * @property {string} id
 * @property {string} name
 * @property {string} email
 * @property {string} role
 * @property {string} team
 * @property {string} location
 * @property {string} hiredOn
 * @property {string} phone
 * @property {string} manager
 * @property {string} status
 */

/**
 * @typedef {object} Team
 * @property {string} id
 * @property {string} name
 * @property {number} headcount
 * @property {string} lead
 */

/**
 * @typedef {object} Contract
 * @property {string} id
 * @property {string} kind
 * @property {string} since
 * @property {string} until
 * @property {number} hours
 */

/**
 * @typedef {object} EmployeeDocument
 * @property {string} id
 * @property {string} name
 * @property {string} kind
 * @property {number} size
 * @property {string} at
 */

export class PeopleService {
  #client;

  /** @param {ApiClient} client */
  constructor(client) {
    this.#client = client;
  }

  /**
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ rows: Employee[], total: number }>}
   */
  employees(signal) {
    return this.#client.get('/employees', undefined, signal);
  }

  /**
   * @param {string} id
   * @param {AbortSignal} [signal]
   * @returns {Promise<Employee>}
   */
  employee(id, signal) {
    return this.#client.get(`/employees/${encodeURIComponent(id)}`, undefined, signal);
  }

  /**
   * @param {string} id
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ rows: Contract[] }>}
   */
  contracts(id, signal) {
    return this.#client.get(`/employees/${encodeURIComponent(id)}/contracts`, undefined, signal);
  }

  /**
   * @param {string} id
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ rows: EmployeeDocument[] }>}
   */
  documents(id, signal) {
    return this.#client.get(`/employees/${encodeURIComponent(id)}/documents`, undefined, signal);
  }

  /**
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ rows: Team[] }>}
   */
  teams(signal) {
    return this.#client.get('/teams', undefined, signal);
  }
}
