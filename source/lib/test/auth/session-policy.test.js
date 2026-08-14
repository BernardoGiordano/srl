import {
  AuthRejected,
  AuthUnavailable,
  expiryFromLifetime,
  failureFor,
  readPayload,
  requireStrings,
  scopesFromSpaceDelimited,
  sessionFrom,
  unreachable,
} from '@auth/session-policy.js';
import { assert } from '../harness.js';

/**
 * Session admission, tested as the trust boundary it is.
 *
 * The case that motivates the whole module is a token endpoint answering HTTP 200
 * with a body missing the fields a session needs. Before admission, that produced
 * a client session whose every field was `undefined`, an `isAuthenticated` signal
 * reading true, and an `Authorization: Bearer undefined` on the next request. The
 * server still refused that request — this was never a server bypass — but the
 * client had already let the user past its guards and had no way back.
 *
 * What is NOT tested here is any endpoint's payload shape, because the library no
 * longer has one: a store maps its own backend's fields and calls `sessionFrom`,
 * and the stores under `example/src/auth/` are tested against their own server.
 * What this file owns is the last step every store funnels through, and the
 * classification — which is not decoration: `AuthSession` schedules refreshes
 * without a human present, and needs "the grant is refused" apart from "nobody
 * answered".
 */

const GOOD_FIELDS = {
  subject: 'user-ada',
  name: 'Ada',
  scopes: ['sales:read', 'analytics:read'],
  expiresAt: Date.now() + 600_000,
};

/**
 * @param {Record<string, unknown>} body
 * @param {number} [status]
 * @returns {Response}
 */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('auth payload admission', () => {
  describe('building a session', () => {
    it('admits well-formed fields', () => {
      const session = sessionFrom(GOOD_FIELDS, 'session');

      assert.equal(session.subject, 'user-ada');
      assert.equal(session.name, 'Ada');
      assert.sameArray(session.scopes, ['sales:read', 'analytics:read']);
      assert.ok(session.expiresAt > Date.now(), 'expiresAt is in the future');
    });

    it('refuses the 200 whose body carried no subject', () => {
      // The finding this module exists for, in one assertion: a store that read a
      // field the server did not send cannot build a session out of `undefined`.
      assert.throws(
        () => sessionFrom({ ...GOOD_FIELDS, subject: undefined }, 'The token endpoint /auth/token'),
        'The token endpoint /auth/token: subject must be a non-empty string',
      );
    });

    it('refuses every other missing or wrong-typed field', () => {
      assert.throws(() => sessionFrom({ ...GOOD_FIELDS, subject: '' }, 'x'), 'subject');
      assert.throws(() => sessionFrom({ ...GOOD_FIELDS, name: null }, 'x'), 'name');
      assert.throws(() => sessionFrom({ ...GOOD_FIELDS, expiresAt: '123' }, 'x'), 'epoch milliseconds');
      assert.throws(() => sessionFrom({ ...GOOD_FIELDS, scopes: 'sales:read' }, 'x'), 'array of strings');
      assert.throws(() => sessionFrom({ ...GOOD_FIELDS, scopes: ['ok', 7] }, 'x'), 'scopes[1]');
    });

    it('re-validates rather than trusting the store that mapped the fields', () => {
      // This is the only way to obtain a Session, so it is the only place that
      // has to be right. A store that read a field by hand cannot produce one the
      // rest of the library then trusts.
      assert.throws(() => sessionFrom({ ...GOOD_FIELDS, expiresAt: Number.NaN }, 'x'), 'expiresAt');
    });

    it('treats absent scopes as no scopes', () => {
      assert.sameArray(sessionFrom({ ...GOOD_FIELDS, scopes: undefined }, 'x').scopes, []);
    });

    it('accepts an expiry that has already passed', () => {
      // A probe answering with an expiry a second in the past is a race the
      // refresh path settles, not a malformed document.
      const session = sessionFrom({ ...GOOD_FIELDS, expiresAt: Date.now() - 1_000 }, 'x');
      assert.ok(session.expiresAt < Date.now(), 'past expiry admitted');
    });

    it('has no field a credential could travel on', () => {
      // A Session is read by guards, screens and the remote host contract, and is
      // the object most likely to be copied into a diagnostic. A store keeps its
      // token in a private field, and this builder takes four named values and
      // copies nothing else through, so there is nowhere for one to ride along.
      const session = sessionFrom(GOOD_FIELDS, 'x');
      assert.sameArray(Object.keys(session).sort(), ['expiresAt', 'name', 'scopes', 'subject']);
    });

    it('freezes what it returns', () => {
      const session = sessionFrom(GOOD_FIELDS, 'x');
      assert.ok(Object.isFrozen(session), 'session frozen');
      assert.ok(Object.isFrozen(session.scopes), 'scopes frozen');
    });

    it('names the field without printing its value', () => {
      // These messages describe an authentication payload. A message that quoted
      // the value would put a credential wherever the message goes.
      let message = '';
      try {
        sessionFrom({ ...GOOD_FIELDS, name: 'super-secret-display-name' }, 'x');
      } catch (cause) {
        message = cause instanceof Error ? cause.message : String(cause);
      }
      assert.equal(message, '', 'a valid string is not refused');

      try {
        expiryFromLifetime('super-secret-lifetime', 'x: expires_in');
      } catch (cause) {
        message = cause instanceof Error ? cause.message : String(cause);
      }
      assert.includes(message, 'expires_in');
      assert.includes(message, '21-character string');
      assert.notOk(message.includes('super-secret'), message);
    });
  });

  describe('the field readers a store maps with', () => {
    it('turns a lifetime in seconds into an absolute instant', () => {
      const expiresAt = expiryFromLifetime(600, 'x');
      const expected = Date.now() + 600_000;
      assert.ok(Math.abs(expiresAt - expected) < 1_000, `${String(expiresAt)} ≈ ${String(expected)}`);
    });

    it('refuses a lifetime that is zero, negative or not a number', () => {
      // A token already expired on arrival would refresh in a loop, and NaN would
      // schedule a refresh that never fires at all.
      for (const seconds of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '600']) {
        assert.throws(() => expiryFromLifetime(seconds, 'x'), 'positive number of seconds');
      }
    });

    it('splits a scope string on any run of whitespace, per RFC 6749', () => {
      assert.sameArray(scopesFromSpaceDelimited(undefined, 'x'), []);
      assert.sameArray(scopesFromSpaceDelimited('  a \n b  ', 'x'), ['a', 'b']);
      assert.throws(() => scopesFromSpaceDelimited(['a'], 'x'), 'non-empty string');
    });

    it('reports the index of the bad entry in a scope list', () => {
      assert.sameArray(requireStrings(['a', 'b'], 'x'), ['a', 'b']);
      assert.throws(() => requireStrings(['ok', 7], 'x'), 'x[1]');
      assert.throws(() => requireStrings('not a list', 'x'), 'array of strings');
    });
  });

  describe('failure classification', () => {
    it('calls a 4xx terminal and a 5xx transient', async () => {
      // The distinction the refresh timer acts on: a refused grant ends the
      // session, an unavailable server does not.
      assert.ok(
        (await failureFor(jsonResponse({}, 400), 'endpoint')) instanceof AuthRejected,
        '400 is terminal',
      );
      assert.ok(
        (await failureFor(jsonResponse({}, 503), 'endpoint')) instanceof AuthUnavailable,
        '503 is transient',
      );
    });

    it('normalizes the server error code into the message', async () => {
      const fromError = await failureFor(jsonResponse({ error: 'invalid_grant' }, 400), 'endpoint');
      assert.includes(fromError.message, 'invalid_grant');

      const fromMessage = await failureFor(jsonResponse({ message: 'expired' }, 400), 'endpoint');
      assert.includes(fromMessage.message, 'expired');
    });

    it('still classifies a failure whose body is unreadable', async () => {
      // This runs on a path that is already failing. An error while building an
      // error message would replace a diagnosable failure with a mystery.
      const html = new Response('<!doctype html><h1>502</h1>', { status: 502 });
      const failure = await failureFor(html, 'endpoint');
      assert.ok(failure instanceof AuthUnavailable, 'transient despite the HTML body');
      assert.includes(failure.message, '502');
    });

    it('calls a transport failure transient', () => {
      assert.ok(unreachable('endpoint', new TypeError('Failed to fetch')) instanceof AuthUnavailable);
    });

    it('refuses a success body that is not JSON', async () => {
      // The most common misconfiguration here: a history fallback in front of a
      // missing route, answering 200 with the application shell.
      await assert.rejects(
        () => readPayload(new Response('<!doctype html>', { status: 200 }), 'The token endpoint'),
        'The token endpoint answered with a body that is not JSON',
      );
    });
  });
});
