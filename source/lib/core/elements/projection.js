/**
 * Light-DOM content projection. The `<ng-content>` equivalent.
 *
 * Components render into light DOM, not shadow DOM, because Tailwind v4 cannot
 * style a shadow root: it registers theme values with `@property`, which is
 * unsupported inside shadow roots, and emits its variables on `:root` rather than
 * `:host`. Choosing Tailwind means choosing light DOM.
 *
 * The bill for that is `<slot>`, a shadow-DOM feature that does not function in
 * light DOM. So projection is manual: capture the authored children before the
 * first render can destroy them, then put them back at `<x-content>` markers after
 * each render. Authoring stays identical to the native API, so the knowledge
 * transfers and a future move to shadow DOM is a find-and-replace.
 */

import { defineElementDefault } from '@core/elements/element-defaults.js';

/** @import { ContentBuckets } from '@core/elements/types.js' */

/** Slot name used for children that carry no `slot` attribute. */
const DEFAULT_SLOT = '';

const MARKER_TAG = 'x-content';
const HOST_ATTR = 'data-projects-content';

/**
 * The marker is `display: contents` so it disappears from layout entirely.
 *
 * This is the detail that makes light-DOM projection usable with Tailwind. An
 * inline-by-default wrapper between a `flex` parent and its children silently
 * breaks every flex and grid utility applied to that parent, and the symptom
 * (spacing that is subtly wrong) is miserable to trace back to a wrapper
 * element you forgot was there.
 *
 * A default, not a rule: `defineElementDefault` puts it in a cascade layer that
 * sorts below Tailwind's, so a `class` on the marker still wins. See that module
 * for why an unlayered rule would not.
 */
defineElementDefault(MARKER_TAG, 'display:contents');

if (!customElements.get(MARKER_TAG)) {
  customElements.define(MARKER_TAG, class ContentMarker extends HTMLElement {});
}

/**
 * Move the element's authored children out of the DOM and bucket them by slot
 * name. Must run before the first render.
 *
 * The nodes are *removed*, not merely read. lit-html clears its container on
 * first render, and relying on the exact moment it does so would make this
 * order-dependent on lit internals. Emptying the host up front makes the
 * outcome the same either way.
 *
 * EVERY NODE IS TAKEN, INCLUDING COMMENTS AND WHITESPACE
 *
 * A lit `ChildPart` is a *range* between two anchor nodes, so an anchor left
 * behind while its content moves makes every render after the first write to the
 * wrong parent. Anchors travel with the content they anchor, in document order,
 * and whitespace travels because it is frequently one of them. ADR-0020.
 *
 * Non-elements go to the default bucket: a comment carries no `slot` attribute,
 * so projecting into a *named* slot requires a whole element — see the note in
 * ui-sidebar-group.js.
 *
 * @param {Element} host
 * @returns {ContentBuckets}
 * @internal
 */
export function captureContent(host) {
  const nodes = Array.from(host.childNodes);

  // Whitespace alone is not content, and a host with none must not be treated as
  // projecting: that flag makes the first render synchronous and keeps buckets
  // alive for the element's lifetime.
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
 * Fill this host's empty `<x-content>` markers from its captured buckets.
 *
 * Idempotent, so it is safe to call after every render. Two cases matter:
 *
 *  - lit reused the marker across renders. It still holds the projected nodes,
 *    so the ownership check skips it and nothing moves.
 *  - lit replaced the marker. The new one is empty and the old one, along with
 *    everything inside it, is detached. Nodes are moved, never cloned, so
 *    identity and event listeners survive.
 *
 * "Is this marker already filled?" is answered by asking whether any captured
 * node still sits in it, rather than by whether it has children. The captured
 * anchors are the stable part — a caller's `*if` deletes the branch it rendered,
 * so the presence of *some* child proves nothing about who owns it.
 *
 * What gets moved into a replacement marker is the previous marker's *current*
 * children, not the captured list. After a few updates those differ: the
 * captured list still names the branch the caller has since deleted, and
 * re-appending it would resurrect content the application removed.
 *
 * @param {Element} host
 * @param {ContentBuckets} buckets
 * @internal
 */
export function projectContent(host, buckets) {
  if (buckets.size === 0) return;

  for (const marker of host.querySelectorAll(MARKER_TAG)) {
    // querySelectorAll is not scoped to this component's own template, so a
    // marker belonging to a nested projecting component would otherwise be
    // filled with the outer component's content.
    if (marker.closest(`[${HOST_ATTR}]`) !== host) continue;

    const bucket = buckets.get(marker.getAttribute('name') ?? DEFAULT_SLOT);
    if (bucket === undefined || bucket.length === 0) continue;
    if (bucket.some((node) => node.parentNode === marker)) continue;

    marker.append(...liveNodes(bucket));
  }
}

/**
 * The nodes to move: whatever the previous marker holds now, or the captured
 * list on the first projection, when nothing holds them yet.
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
