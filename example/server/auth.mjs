/**
 * The backend half of the `bff` token strategy.
 *
 * `src/auth/bff-cookie-store.js` is the browser half, and the contract between
 * the two is three endpoints:
 *
 *   POST   /auth/login    credentials in, Set-Cookie + a CSRF token out
 *   DELETE /auth/login    clears the cookie and forgets the session
 *   GET    /auth/session  the current session, or 401
 *
 * WHY THIS EXISTS RATHER THAN A FAKE
 *
 * JavaScript cannot set a cookie JavaScript may not read, so an in-browser fake
 * cannot demonstrate the strategy this application uses. This file is the whole
 * of it: about a hundred lines, roughly the honest cost of that architecture.
 *
 * WHAT THE BROWSER GETS
 *
 *   sid    an opaque session id in an HttpOnly, SameSite=Strict cookie. No
 *          JavaScript on the origin can read it, so an XSS payload cannot copy it
 *          out to another machine.
 *   csrf   a random string returned in the JSON body, readable on purpose. Its job
 *          is to be attachable by this application's JavaScript and not by a
 *          cross-site form post, so every mutating request must carry it in
 *          `X-CSRF-Token`.
 *
 * `Secure` is deliberately absent: this server is http://localhost and a Secure
 * cookie would never be stored, which would look exactly like a broken login. In
 * production it is mandatory, and the flag is set below where a deployment would
 * flip it.
 *
 * WHAT IS SHORT-LIVED, AND WHY
 *
 * `apiValidUntil` reproduces a real BFF's access-token expiry: API requests past it
 * are refused with a real 401, and `GET /auth/session` — what the store's `refresh()`
 * calls — extends it. That is the path `authorizedFetch` retries through, so the
 * example exercises refresh-and-retry rather than describing it.
 */

import { randomUUID } from 'node:crypto';

import { USERS, audit, scopesForRole } from './data.mjs';

/** How long an API call is accepted before the BFF has to refresh. */
const ACCESS_WINDOW_MS = 180_000;

/** How long a session survives without any refresh at all. */
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export const COOKIE_NAME = 'sid';

/**
 * @typedef {object} ServerSession
 * @property {string} id
 * @property {string} username
 * @property {string} name
 * @property {string} role
 * @property {string[]} scopes
 * @property {string} csrf
 * @property {number} apiValidUntil
 * @property {number} absoluteExpiry
 */

/** @type {Map<string, ServerSession>} */
const sessions = new Map();

/**
 * Which role a password grants.
 *
 * A password as a role selector is not authentication and is not pretending to be:
 * it is the smallest thing that lets one running server demonstrate three different
 * entitlement sets, which is what the guards, the scope checks and the `/forbidden`
 * route need in order to be visible at all.
 *
 * @param {string} password
 * @returns {string | null}
 */
function roleFor(password) {
  switch (password) {
    case 'admin':
      return 'administrator';
    case 'operator':
      return 'operator';
    case 'viewer':
      return 'viewer';
    default:
      return null;
  }
}

/**
 * @param {string | undefined} header
 * @returns {Map<string, string>}
 */
export function parseCookies(header) {
  /** @type {Map<string, string>} */
  const cookies = new Map();
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    cookies.set(part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim()));
  }
  return cookies;
}

/**
 * The session a request belongs to, or null. Expired sessions are dropped here
 * rather than by a sweeper: one map, one place that decides a session is over.
 *
 * @param {import('node:http').IncomingMessage} request
 * @returns {ServerSession | null}
 */
export function sessionOf(request) {
  const id = parseCookies(request.headers.cookie).get(COOKIE_NAME);
  if (id === undefined) return null;
  const session = sessions.get(id);
  if (session === undefined) return null;
  if (Date.now() > session.absoluteExpiry) {
    sessions.delete(id);
    return null;
  }
  return session;
}

/**
 * The body the store reads: `sub`, `name`, `scopes`, `expiresAt`, `csrfToken`.
 * Nothing else, and in particular no token — the whole point of the strategy is
 * that there is no credential in this response.
 *
 * @param {ServerSession} session
 */
export function sessionBody(session) {
  return {
    sub: session.username,
    name: session.name,
    scopes: session.scopes,
    expiresAt: session.apiValidUntil,
    csrfToken: session.csrf,
    role: session.role,
  };
}

/**
 * @param {{ username?: unknown, password?: unknown }} credentials
 * @returns {{ session: ServerSession, cookie: string } | null}
 */
export function login(credentials) {
  const username = typeof credentials.username === 'string' ? credentials.username.trim() : '';
  const password = typeof credentials.password === 'string' ? credentials.password : '';
  const role = roleFor(password);
  if (username === '' || role === null) return null;

  const known = USERS.find((user) => user.email.startsWith(`${username.toLowerCase()}.`));
  const now = Date.now();
  /** @type {ServerSession} */
  const session = {
    id: randomUUID(),
    username,
    name: known?.name ?? capitalize(username),
    role,
    scopes: scopesForRole(role),
    csrf: randomUUID(),
    apiValidUntil: now + ACCESS_WINDOW_MS,
    absoluteExpiry: now + SESSION_TTL_MS,
  };
  sessions.set(session.id, session);
  audit('session.login', session.name, session.username, `role ${role}`);

  return { session, cookie: cookieHeader(session.id, SESSION_TTL_MS) };
}

/**
 * What the store's `refresh()` reaches: the BFF renewing its access token behind
 * the cookie. Nothing about the exchange is visible to the browser, which is the
 * property being demonstrated.
 *
 * @param {ServerSession} session
 */
export function renew(session) {
  session.apiValidUntil = Date.now() + ACCESS_WINDOW_MS;
  return session;
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @returns {string} The `Set-Cookie` value that clears the cookie.
 */
export function logout(request) {
  const id = parseCookies(request.headers.cookie).get(COOKIE_NAME);
  if (id !== undefined) sessions.delete(id);
  return cookieHeader('', 0);
}

/**
 * Is this request allowed to mutate? A cross-site form post carries the cookie —
 * that is what SameSite mitigates and what this backs up — but it cannot read the
 * CSRF token out of a JSON response body, so it cannot set the header.
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {ServerSession} session
 * @returns {boolean}
 */
export function csrfValid(request, session) {
  const method = (request.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return true;
  const header = request.headers['x-csrf-token'];
  return typeof header === 'string' && header === session.csrf;
}

/**
 * @param {ServerSession} session
 * @returns {boolean} Whether the BFF's access token is still inside its window.
 */
export function accessFresh(session) {
  return Date.now() <= session.apiValidUntil;
}

/**
 * @param {string} id
 * @param {number} maxAgeMs
 * @returns {string}
 */
function cookieHeader(id, maxAgeMs) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(id)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${String(Math.floor(maxAgeMs / 1000))}`,
    // Production: add 'Secure'. Omitted because this server is plain http on
    // localhost, where a Secure cookie is discarded by the browser without a
    // warning anywhere.
  ];
  return parts.join('; ');
}

/** @param {string} value */
function capitalize(value) {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}
