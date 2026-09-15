# ADR-0010: Manifest admission is one whole-document decision

- Status: accepted
- Date: 2026-08-12
- Affects: `source/lib/core/remotes/manifest-policy.js`, `tools/checks/verify-deps.mjs`

## Context

The browser fetches `app.manifest.json` on every load. The manifest decides where code is imported from, where credentials go, which path each remote owns and which files seed the locale and template caches.

Checking fields one at a time misses the dangerous cases, because each of them is valid on its own. A token endpoint on another origin is a valid string. Two remotes claiming `/billing` are two valid entries. A mount that swallows another remote's subtree only misbehaves later, inside the router.

## Decision

`manifest-policy.js` admits the whole document before anything reads it. Code downstream reads the admitted value, which is normalized, checked for collisions and frozen. No other module parses the raw manifest.

Every URL in the manifest must be a same-origin, root-relative path. Admission rejects anything else and never repairs it, because a repaired URL is a tampered file that loaded anyway. Remote code runs in the shell's realm, the token endpoint receives credentials and the API base receives authorization, so none of them may leave the origin.

The module imports nothing. `npm run verify` loads it in Node and admits every checked-in manifest with the rules the browser applies, so a bad manifest fails in CI before it fails in production.

## Consequences

- A new manifest field needs an admission rule before anything can read it.
- Cross-origin authentication can't be expressed in the manifest. It belongs to the deployment, with CORS, a token for that audience and a CSP that allows it.
- A manifest compiled into the build instead of fetched at runtime would reopen this, because it has a different threat model.
