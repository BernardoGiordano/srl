import { inject } from '@core/foundation/inject.js';
import { AUTH_SESSION } from '@auth/session.js';

/**
 * The session, as the transport `@core/http/client.js` sends through.
 *
 * `core/` may not import `auth/` — the same rule that keeps `core/remotes/mfe.js`
 * free of the session — so the HTTP client takes its transport as a parameter and
 * this is the adapter for the ordinary case: an application whose API calls are
 * the signed-in user's. It is one line, and it is in the library rather than in
 * each `main.js` because of what the line has to get right.
 *
 * The session is injected per call rather than captured here. It is a
 * longer-lived object than any one request, and a transport that resolved it once
 * would hold a disposed session alive across a re-bootstrap and authorize
 * requests against it.
 *
 * @type {import('@core/http/client.js').HttpTransport}
 */
export function sessionFetch(url, init) {
  return inject(AUTH_SESSION).fetch(url, init);
}
