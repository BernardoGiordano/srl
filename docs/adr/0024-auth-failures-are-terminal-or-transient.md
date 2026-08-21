# ADR-0024: An authentication failure is either terminal or transient, never both

- Status: accepted
- Date: 2026-08-12
- Affects: `source/lib/auth/session-policy.js`, `source/lib/auth/session.js`

## Context

`AuthSession` schedules a refresh before every expiry, and that timer has to act on the
result with no human present.

One error type for every failure forces the timer to pick one wrong behaviour for two
opposite situations: end the session when the Wi-Fi drops, or keep an authenticated
session holding a token that is definitively dead. Both are visible to users — the first
as a random logout, the second as every request failing while the UI claims to be signed
in.

## Decision

Two error types, distinguished by whether retrying could produce a different answer:

- **`AuthRejected`** — terminal. The grant was refused (4xx) or the payload could not be
  admitted. Retrying sends the same credentials to the same endpoint for the same answer.
  The session ends.
- **`AuthUnavailable`** — transient. Transport failed or the server answered 5xx. The
  session's own expiry has not passed, so the honest state is "not yet known" and the
  caller may retry until it does.

## Consequences

The refresh timer, the 401 retry and the startup restore all read the same distinction and
need no rules of their own.

The classification is a policy decision made in one place, so a new failure mode — a
gateway that answers 403 for an outage, say — is a change to one function rather than to
every caller that guessed.
