# ADR-0024: An authentication failure is terminal or transient

- Status: accepted
- Date: 2026-08-12
- Affects: `source/lib/auth/session-policy.js`, `source/lib/auth/session.js`

## Context

`AuthSession` refreshes before each expiry, and the timer must act on the result with no user present. With a single error type, the timer has to pick one wrong behavior for two opposite cases. It either logs the user out when the Wi-Fi drops, or keeps a session alive on a token that is dead.

## Decision

There are two error types, and they differ in whether a retry could change the answer.

- `AuthRejected` is terminal. The grant was refused (4xx) or the payload couldn't be admitted, and the session ends.
- `AuthUnavailable` is transient. The transport failed or the server returned 5xx. The session's expiry hasn't passed, so the caller may retry.

## Consequences

- The refresh timer, the 401 retry and the startup restore all use the same distinction.
- Classification lives in one function, so a gateway that answers 403 during an outage is a one-function change.
