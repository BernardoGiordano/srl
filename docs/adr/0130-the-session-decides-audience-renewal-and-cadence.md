# ADR-0130: The session decides audience, renewal and cadence

- Status: accepted
- Date: 2026-10-06
- Affects: `source/lib/auth/session.js`, `source/lib/auth/session-policy.js`, `source/lib/auth/types.d.ts`, `source/lib/host/remote-host.js`, `example/src/auth/`

## Context

`AuthSession` handed three decisions to stores that made none, and ran two different
operations as one.

`fetch()` passed every request to `store.authorize()`, whatever its URL. Each sample
store attached its Bearer token or CSRF header to any origin it was handed.

Admitting only the initial origin also left Fetch free to follow redirects.
A 307 could forward custom credential headers and the request body to an origin
outside the audience. A store can rebuild the request, so setting redirect refusal
before authorization does not constrain the request that reaches Fetch.

A 401 called `refresh()` whether or not a session was live. After a logout whose
revocation call failed, the refresh cookie survived, so the next 401 spent it, signed
the user back in and retried the request. Renewing a live session and restoring an
absent one were the same call. The samples swallowed the failed revocation, so nothing
told the user.

The refresh timer fired `expiresAt - 60s` from now. A lifetime of 60 seconds or less, a
client clock ahead of the server's, or an expiry past `2^31 - 1` ms (about 24.8 days),
where engines fire the timer at once, each put every refresh at zero delay. Chrome ran
141 refreshes in 2 seconds.

Cross-tab messages used one `BroadcastChannel('auth')` per origin. A second application
on the origin, or a second session in the same page, applied the first one's logout.
Revoking a remote's host context also left its requests running.

Four alternatives lost.

**Audience in each store.** Stores are application code, copied and adapted. Three
copies of one check drift, and all three samples skipped it. The session already holds
every request.

**Refusing a request outside the audience.** `fetch()` carries every call an
application routes through it, including public ones on other origins. A request sent
without credentials leaks nothing, and refusing it would break those calls.

**A fixed floor alone.** It still refreshes a 30-second token every few seconds, and
loops forever at the floor on a skewed clock.

**A channel name derived from the page.** Nothing in the page identifies the
application. Routes change the URL, and `<base>` is optional.

## Decision

`AuthSession` takes options beside its store.

- `audience` lists the origins a request may carry credentials to, and defaults to the
  page's own. Each entry must be an origin. `authorize()` returns any other request
  unchanged, and that request's 401 renews nothing.
- `name` names the cross-tab channel `srl-auth:<name>`, and defaults to `default`.
  Applications sharing an origin pass distinct names. A session ignores broadcasts
  from its own document, because another session in the same page shares no state with
  it.

`AuthSession.fetch()` sends a request admitted to the audience with
`redirect: 'error'`, applied to the final request after store authorization on
both the first send and the retry. All redirects are refused, including those
within the audience. A request outside the audience keeps its redirect behavior
because the session attached no credentials to it.

`refresh()` renews only a live session. With none, it resolves null without asking the
store. Restoring a session is `init()`'s job.

The timer refreshes a minute before expiry, or halfway through a lifetime shorter than
two minutes. When an answer arrives with its next refresh due within 5 seconds, the
refresh bought no time. The first such answer is honoured, and each one after it waits
on the transient-failure backoff of 1, 5, 15 and 60 seconds. A wait past the timer's
range re-arms at the limit until the instant is in range. `requireInstant()` refuses an
expiry no `Date` can hold.

The sample stores reject a logout the server did not confirm. Local state clears first,
and the DPoP store rotates its key either way. Revoking a remote's host context aborts
its requests and body reads.

## Consequences

- An API on another origin needs its origin in `audience`. Until then, its requests go
  out without credentials and come back 401.
- An admitted API endpoint that redirects causes a Fetch `TypeError`. Callers must
  use its final URL directly so that audience admission precedes authorization.
- `logout()` rejects when revocation fails. The session is still cleared locally, and
  the application decides what to tell the user.
- A session whose clock disagrees with the server's refreshes once a minute rather
  than continuously. Its transient refresh failure still ends the session at once,
  because the client reads the expiry as past.
- Tabs on the earlier `auth` channel and tabs on `srl-auth:default` don't coordinate
  until both have loaded the same release.
- A `Date`-based skew estimate from the token response would let the timer correct for
  a skewed clock instead of backing off.
