# ADR-0012: Every manifest URL is a same-origin root-relative path

- Status: accepted
- Date: 2026-08-12
- Affects: `source/lib/core/remotes/manifest-policy.js`

## Context

`grants.api` has been restricted to the shell's own origin since it existed. The other
URL-bearing fields of `app.manifest.json` — the token endpoint, the API base, each
remote's entry — were only checked for being non-empty.

Each of those destinations receives something that cannot be taken back. Remote code
executes in the shell's realm. The token endpoint receives the user's credentials. The API
base receives their authorization material. The hardened deployment serves
`connect-src 'self'`, so a cross-origin destination is either a mistake or a tampered
file, and in both cases the shell is what would carry it out.

## Decision

Admission requires every URL in the manifest to be a same-origin root-relative path, and
rejects anything else rather than repairing it. Rejecting rather than normalizing is the
point: a repaired URL is a tampered file that loaded anyway.

## Consequences

Cross-origin authentication is not expressible as a manifest string. It needs CORS on the
other origin, a token minted for that audience, and a deployment whose CSP admits it — a
capability of a deployment, declared and tested as one, not a value a fetched JSON file
can introduce at startup.

That is the intended shape of the reopening condition too: a genuine cross-origin
deployment adds the capability at the deployment layer, and this rule stays as it is.
