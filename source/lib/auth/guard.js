import { inject } from '@core/foundation/inject.js';
import { guard } from '@core/navigation/router.js';
import { AUTH_SESSION } from '@auth/session.js';

/** @import { RouteGuard } from '@core/navigation/types.js' */

/**
 * Route guards. Angular's `authGuard` and role guard.
 *
 * These read a settled session, because main.js awaits `AuthSession.init()`
 * before the router resolves its first route. Guarding on a session that is still
 * being restored is the classic cause of "refreshing a deep link bounces me to
 * the login page", and ordering it away once at startup is simpler than making
 * every guard await a restore.
 */

/** Require a session. */
export const requireSession = guard(() => inject(AUTH_SESSION).isAuthenticated.value, '/login');

/**
 * Require a scope. Angular's role guard.
 *
 * @param {string} scope
 * @returns {RouteGuard}
 */
export function requireScope(scope) {
  return guard(() => inject(AUTH_SESSION).scopes.value.includes(scope), '/forbidden');
}
