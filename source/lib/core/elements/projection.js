/**
 * Light-DOM content projection, the equivalent of `<ng-content>`.
 *
 * Components render into light DOM because Tailwind v4 can't style a shadow root.
 * It registers theme values with `@property`, which shadow roots don't support, and
 * emits its variables on `:root`. `<slot>` only works in shadow DOM, so projection
 * is manual. Authored children are captured before the first render and put back at
 * `<x-content>` markers after each render. The authoring syntax matches the native
 * API.
 */

import { defineElementDefault } from '@core/elements/element-defaults.js';

/** @import { ContentBuckets } from '@core/elements/types.js' */

/** Slot name used for children that carry no `slot` attribute. */
const DEFAULT_SLOT = '';

const MARKER_TAG = 'x-content';
const HOST_ATTR = 'data-projects-content';

/**
 * The marker uses `display: contents`, so it disappears from layout. A wrapper
 * between a flex or grid parent and its children would break the parent's
 * utilities.
 *
 * `defineElementDefault` puts the rule in a layer below Tailwind's, so a class on
 * the marker still wins.
 */
defineElementDefault(MARKER_TAG, 'display:contents');

if (!customElements.get(MARKER_TAG)) {
  customElements.define(MARKER_TAG, class ContentMarker extends HTMLElement {});
}

/**
 * Remove the element's authored children and group them by slot name. Runs before
 * the first render.
 *
 * Removing the nodes up front means the result doesn't depend on when lit-html
 * clears its container.
 *
 * Every node moves, comments and whitespace included. A lit `ChildPart` is a range
 * between two anchor nodes, and an anchor left behind would make later renders
 * write to the wrong parent.
 *
 * Non-elements go to the default slot. A comment has no `slot` attribute, so a named
 * slot needs a whole element.
 *
 * @param {Element} host
 * @returns {ContentBuckets}
 * @internal
 */
export function captureContent(host) {
  const nodes = Array.from(host.childNodes);

  // A host with only whitespace doesn't project. Treating it as projecting would
  // make its first render synchronous and keep its buckets alive.
  const meaningful = nodes.some(
    (node) => node instanceof Element || node.nodeType === Node.COMMENT_NODE,
  );

  /** @type {ContentBuckets} */
  const buckets = new Map();
  if (!meaningful) return buckets;

  for (const node of nodes) {
    const name =
      node instanceof Element ? (node.getAttribute('slot') ?? DEFAULT_SLOT) : DEFAULT_SLOT;

    let bucket = buckets.get(name);
    if (bucket === undefined) {
      bucket = [];
      buckets.set(name, bucket);
    }
    bucket.push(node);
    node.parentNode?.removeChild(node);
  }

  host.setAttribute(HOST_ATTR, '');
  return buckets;
}

/**
 * Fill this host's empty `<x-content>` markers from its captured buckets. Safe to
 * call after every render.
 *
 * - If lit reused a marker, it still holds the projected nodes and nothing moves.
 * - If lit replaced a marker, the new one is empty. Nodes move into it and keep
 *   their identity and listeners.
 *
 * A marker counts as filled when a captured node still sits in it. A caller's `*if`
 * can delete a branch, so having some child proves nothing.
 *
 * A replacement marker receives the old marker's current children, because the
 * captured list may still name a branch the application has since removed.
 *
 * @param {Element} host
 * @param {ContentBuckets} buckets
 * @internal
 */
export function projectContent(host, buckets) {
  if (buckets.size === 0) return;

  for (const marker of host.querySelectorAll(MARKER_TAG)) {
    // Skip markers that belong to a nested projecting component.
    if (marker.closest(`[${HOST_ATTR}]`) !== host) continue;

    const bucket = buckets.get(marker.getAttribute('name') ?? DEFAULT_SLOT);
    if (bucket === undefined || bucket.length === 0) continue;
    if (bucket.some((node) => node.parentNode === marker)) continue;

    marker.append(...liveNodes(bucket));
  }
}

/**
 * The nodes to move. That is the previous marker's current children, or the
 * captured list on the first projection.
 *
 * @param {readonly Node[]} bucket
 * @returns {Node[]}
 */
function liveNodes(bucket) {
  for (const node of bucket) {
    const parent = node.parentNode;
    if (parent instanceof Element && parent.localName === MARKER_TAG) {
      return Array.from(parent.childNodes);
    }
  }
  return Array.from(bucket);
}
