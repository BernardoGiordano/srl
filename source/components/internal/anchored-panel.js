/**
 * Pin a floating panel to the control that opened it.
 *
 * WHY A PANEL IS NOT JUST `absolute`
 *
 * A panel left in the normal flow pushes the rest of the page down when it
 * opens, which is the one thing a dropdown must never do. `position: absolute`
 * fixes that and buys a second bug: the panel is still painted inside its
 * ancestors, so a single `overflow-hidden` on a card — the ordinary way to make
 * a rounded border clip the table inside it — cuts the panel off, and no
 * z-index rescues it.
 *
 * So the panel is promoted to the top layer with `popover`, where no ancestor's
 * overflow, stacking context or transform can reach it, and its coordinates are
 * written here: under the anchor, flipped above when there is more room there,
 * clamped into the viewport, re-measured whenever anything moves. That last part
 * is what a `placement` property would owe you and rarely delivers.
 *
 * A browser without `popover` keeps the fixed positioning and loses only the
 * immunity to a clipping ancestor, which is the same behaviour this component
 * collection had before.
 */

import { isRtl } from './dom.js';

/** Breathing room kept between the panel and the edge of the viewport. */
const VIEWPORT_MARGIN = 8;

/** A panel shorter than this is not worth flipping or scrolling. */
const MIN_HEIGHT = 96;

/**
 * @typedef {{
 *   align?: 'stretch' | 'start' | 'end',
 *   gap?: number,
 *   maxHeight?: number,
 * }} AnchorOptions
 */

/**
 * Show `panel` in the top layer, positioned against `anchor`, and keep it there.
 *
 *     this.#release = anchorPanel(control, panel, { align: 'stretch' });
 *     …
 *     this.#release();
 *
 * `align: 'stretch'` matches the anchor's width, which is what a select wants;
 * `'start'` and `'end'` are logical edges and follow the anchor's writing
 * direction.
 *
 * @param {HTMLElement} anchor
 * @param {HTMLElement} panel
 * @param {AnchorOptions} [options]
 * @returns {() => void} Stops following, and hides the panel again.
 */
export function anchorPanel(anchor, panel, options = {}) {
  const settings = {
    align: options.align ?? 'stretch',
    gap: options.gap ?? 4,
    maxHeight: options.maxHeight ?? 320,
  };

  reveal(panel);
  const place = () => {
    position(anchor, panel, settings);
  };
  place();

  const controller = new AbortController();
  // Capture, because the element that scrolls is almost never the window: an
  // anchor inside a scrolling card moves with it and the panel has to follow.
  const listener = { capture: true, passive: true, signal: controller.signal };
  window.addEventListener('scroll', place, listener);
  window.addEventListener('resize', place, listener);

  // The panel's own size changes under it — a lazy list finishing its load, a
  // search replacing ten rows with one — and each of those moves the flip
  // decision and the clamp.
  const observer = new ResizeObserver(place);
  observer.observe(anchor);
  observer.observe(panel);

  return () => {
    controller.abort();
    observer.disconnect();
    conceal(panel);
  };
}

/** @param {HTMLElement} panel */
function reveal(panel) {
  if (!supportsPopover(panel)) return;
  panel.popover = 'manual';
  // `manual` rather than `auto`: light dismissal would close the panel on the
  // very pointerdown that is selecting an option, and every component here
  // already owns its outside-click and Escape handling.
  if (!panel.matches(':popover-open')) panel.showPopover();
}

/** @param {HTMLElement} panel */
function conceal(panel) {
  if (!supportsPopover(panel) || !panel.isConnected) return;
  if (panel.matches(':popover-open')) panel.hidePopover();
}

/** @param {HTMLElement} panel */
function supportsPopover(panel) {
  return 'popover' in panel;
}

/**
 * @param {HTMLElement} anchor
 * @param {HTMLElement} panel
 * @param {{ align: 'stretch' | 'start' | 'end', gap: number, maxHeight: number }} settings
 */
function position(anchor, panel, settings) {
  const box = anchor.getBoundingClientRect();
  const style = panel.style;

  style.position = 'fixed';
  style.inset = 'auto';
  style.margin = '0';
  if (settings.align === 'stretch') style.width = `${String(Math.round(box.width))}px`;

  // How tall the panel wants to be, read from its content rather than by clearing
  // `max-height` and measuring. Clearing it works exactly once: the second time,
  // the panel is scrolled, and letting it snap to full height for one frame
  // collapses `scrollTop` to zero on the way back — which looks like the list
  // jumping to the top whenever anything moves.
  const natural = panel.scrollHeight + (panel.offsetHeight - panel.clientHeight);

  const below = window.innerHeight - box.bottom - settings.gap - VIEWPORT_MARGIN;
  const above = box.top - settings.gap - VIEWPORT_MARGIN;
  const flip = natural > below && above > below;
  const room = Math.max(MIN_HEIGHT, flip ? above : below);
  const height = Math.min(natural, room, settings.maxHeight);
  style.maxHeight = `${String(Math.min(room, settings.maxHeight))}px`;

  style.top = `${String(Math.round(flip ? Math.max(VIEWPORT_MARGIN, box.top - settings.gap - height) : box.bottom + settings.gap))}px`;

  const width = panel.offsetWidth;
  const rtl = isRtl(anchor);
  const flushEnd = (settings.align === 'end') !== rtl;
  const preferred = flushEnd ? box.right - width : box.left;
  const furthest = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);
  style.left = `${String(Math.round(Math.min(Math.max(VIEWPORT_MARGIN, preferred), furthest)))}px`;
}
