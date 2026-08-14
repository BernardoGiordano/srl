import { createAnalyticsRoot } from './analytics-root.js';

/**
 * The micro-frontend that shares nothing with the shell.
 *
 * Look at the import list above: one relative path and no bare specifiers at all. No Lit,
 * no signals, no template compiler, no dependency injection, no shell module of any kind.
 * `analytics-root.js` builds DOM with `document.createElement`, keeps its state in ordinary
 * variables, and would behave identically if it were React with its own bundler and its own
 * release train. Nothing in this folder resolves through the shell's import map, which is
 * the property that makes it genuinely deployable on its own.
 *
 * Compare `remotes/billing/`, which imports the shell's Lit, the shell's signals and two of
 * the shell's components. That is the easy case, and it is the one every micro-frontend
 * demo shows: same framework, same version, same conventions, so "independent deployment"
 * costs nothing and proves nothing. This is the hard case.
 *
 * It still needs four things it cannot have on its own: the user's identity, permission to
 * call an API as that user, the active locale, and a way to navigate. It receives all four
 * as arguments. That is the entire coupling — one mount path, one tag, one function call —
 * and it is the smallest coupling under which "share the session" is possible at all.
 *
 * No token appears anywhere in this folder. `host.auth` offers an authorized `fetch` and no
 * way to obtain a credential, so this remote cannot leak one, log one or persist one.
 * Whether the shell is running `bff`, `memory` or `dpop` is invisible here and needs no
 * change here — which is exactly what the shell switching to `bff` for this example
 * demonstrated: not one line of this folder moved.
 */

/**
 * The host contract version this remote is written against. The shell refuses to load a
 * remote whose number does not match its own, so a shell upgrade that changes a capability
 * is a failed load naming both versions rather than a `TypeError` on the first click.
 */
export const contract = 2;

/** Tag of this remote's root element. Defined by `mount` below. */
export const rootTag = 'analytics-root';

/**
 * @param {import('../../../source/lib/core/remotes/types.js').HostContext} host
 * @returns {HTMLElement}
 */
export function mount(host) {
  // Each root receives this mount's context before it is connected. No context is stored at
  // module scope, so a second visit cannot reuse the revoked first mount's authority.
  return createAnalyticsRoot(rootTag, host);
}
