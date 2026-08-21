# ADR-0022: The single-flight refresh is per-session state

- Status: accepted
- Date: 2026-08-12
- Affects: `source/lib/auth/session.js`

## Context

A refresh has to be shared across concurrent 401s, coordinated across tabs, scheduled
before expiry, retried when the network is down but not when the grant is refused, and
abandoned on disposal. Each of those rules used to live in a different file, in module
scope, or nowhere.

The single-flight refresh is the clearest case of what that costs. It was a module-level
`refreshInFlight` variable in a separate `authorized-fetch.js`, which made it shared by
every `AuthSession` in the process rather than by every caller of one. Two applications on
a page, or two suites in one test run, deduplicated against each other's sessions — one
session's refresh satisfied another session's 401, and the second application proceeded
with a token that was never minted for it.

## Decision

One module owns the session from restore to disposal, and every outbound request that
carries it. The in-flight refresh is a private field of `AuthSession`, which is what it
always described. Callers get `login`, `logout`, `fetch`, `json` and three signals; they
do not get the ordering rules, because the ordering rules were the part that kept escaping.

## Consequences

Two sessions on one page are independent, which is what makes a browser test suite able to
construct sessions freely and what makes a shell plus a remote with its own session
possible at all.

The module is larger than the sum of the files it replaced, and deliberately so: the
alternative is the ordering rules spread across the modules that happen to trigger them.
