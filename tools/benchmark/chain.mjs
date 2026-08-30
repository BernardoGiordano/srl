/**
 * How deep a load's request chain is: not how many transfers it made, but how many
 * of them had to wait for another one to arrive first.
 *
 * WHY THIS IS THE NUMBER
 *
 * Zero network comes from `--host-resolver-rules`, so nothing measured here pays a
 * real round trip: every request is answered by a local server in well under a
 * millisecond. That makes depth the only latency fact that survives the measurement.
 * A request count cannot tell twenty transfers in one round trip from twenty in
 * series, and a byte total cannot either — both are identical in the two cases,
 * which is how a page that spent a second discovering ten kilobytes of JavaScript
 * one hop at a time passed a green gate.
 *
 * WHAT COUNTS AS A CHAIN
 *
 * The causal graph the protocol already reports: each request names the parser,
 * script or preload that asked for it, and `browser.mjs` keeps that as
 * `initiator.url`. A request whose initiator is on the origin hangs off it; the
 * navigation itself, and anything the protocol attributes to no URL, is a root.
 * Depth is the longest root-to-leaf walk, counting the root as 1.
 *
 * Pure — records in, depth out — so the rule is asserted from a literal rather than
 * by loading a page and hoping it is slow in the right way. ADR-0082.
 */

/** @import { RequestRecord } from './types.js' */

/**
 * The longest causal chain in one set of recorded requests.
 *
 * The first record for a URL owns it: a page that fetches the same asset twice is
 * making one discovery, and attributing later requests to the second copy would
 * report a chain that depends on cache state rather than on the graph.
 *
 * A preload hint is what shortens a chain, and it shortens it here for the same
 * reason it shortens it in the browser: the request is attributed to the document
 * that named it rather than to the module that would otherwise have discovered it.
 *
 * @param {readonly RequestRecord[]} records
 * @returns {{ depth: number, path: string[] }}
 */
export function requestChain(records) {
  /** @type {Map<string, RequestRecord>} */
  const byUrl = new Map();
  for (const record of records) {
    if (!byUrl.has(record.url)) byUrl.set(record.url, record);
  }

  /** @type {Map<string, string[]>} */
  const chains = new Map();

  /**
   * @param {string} url
   * @param {Set<string>} walking
   * @returns {string[]}
   */
  const chainTo = (url, walking) => {
    const known = chains.get(url);
    if (known !== undefined) return known;
    // A cycle is not a chain the browser could have walked. The walk stops here and
    // the request that closed the loop becomes the chain's root, rather than
    // appearing on it twice.
    if (walking.has(url)) return [];
    const parent = byUrl.get(url)?.initiator.url ?? null;
    if (parent === null || parent === url || !byUrl.has(parent)) return [url];
    walking.add(url);
    const chain = [...chainTo(parent, walking), url];
    walking.delete(url);
    chains.set(url, chain);
    return chain;
  };

  /** @type {string[]} */
  let deepest = [];
  for (const url of byUrl.keys()) {
    const chain = chainTo(url, new Set());
    if (chain.length > deepest.length) deepest = chain;
  }
  return { depth: deepest.length, path: deepest };
}

/**
 * The requests one page load had made by the time its first view was on screen.
 *
 * Everything after that moment is a different question — a `resource()` from
 * `onMount` is data for a view the user is already looking at — and letting those
 * extend the chain would make the depth depend on how long the harness waited
 * before reading the marks.
 *
 * @param {readonly RequestRecord[]} records
 * @param {number} settledAt Wall-clock ms: `performance.timeOrigin + firstView`.
 * @returns {RequestRecord[]}
 */
export function until(records, settledAt) {
  return records.filter((record) => record.startedAt <= settledAt);
}
