import { token } from '@core/foundation/inject.js';

/** @import { ApiClient } from '@core/http/client.js' */

/**
 * The Settings section's own resources: application accounts and the audit trail.
 *
 * Both endpoints are scope-gated on the server (`users:read`, `users:write`,
 * `audit:read`), and the routes that reach them are guarded with the same scopes in
 * `routes.js`. The duplication is deliberate: the guard is why a viewer does not see
 * a screen full of errors, and the server check is why not seeing the screen is not
 * the thing keeping them out.
 */

/** @type {import('@core/foundation/types.js').InjectionToken<AdminService>} */
export const ADMIN_SERVICE = token('AdminService');

/**
 * @typedef {object} AccountUser
 * @property {string} id
 * @property {string} name
 * @property {string} email
 * @property {string} role
 * @property {string} status
 * @property {string} lastSeen
 * @property {number} scopeCount
 */

/**
 * @typedef {object} AuditEntry
 * @property {string} id
 * @property {string} at
 * @property {string} actor
 * @property {string} action
 * @property {string} target
 * @property {string} detail
 */

export class AdminService {
  #client;

  /** @param {ApiClient} client */
  constructor(client) {
    this.#client = client;
  }

  /**
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ rows: AccountUser[] }>}
   */
  users(signal) {
    return this.#client.get('/users', undefined, signal);
  }

  /**
   * @param {string} id
   * @param {'active' | 'suspended'} status
   * @returns {Promise<AccountUser>}
   */
  setUserStatus(id, status) {
    return this.#client.patch(`/users/${encodeURIComponent(id)}`, { status });
  }

  /**
   * @param {number} limit
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ rows: AuditEntry[], total: number }>}
   */
  audit(limit, signal) {
    return this.#client.get('/audit', { limit }, signal);
  }
}
