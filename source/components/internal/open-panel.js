/**
 * Everything an open panel has to do, in one place.
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
 *
 * WHY POSITIONING WAS NOT THE WHOLE JOB
 *
 * Positioning was all this module used to own, and it is the part an open panel
 * shares least: `ui-menu` positions its own with two utility classes and needs
 * none of it. What every open panel does need was restated per element instead —
 * outside-pointerdown dismissal three times, Escape three times, the release
 * bookkeeping twice in eighteen near-identical lines, and the `aria-expanded`
 * and `aria-controls` pair spelled differently in each template, missing
 * altogether on the table's column chooser, and pointing at an id with no
 * element behind it whenever the combobox was closed.
 *
 * Four habits for one concept is how they disagree. So the concept is the export:
 * `openPanel()` opens one and returns the single call that undoes all of it, and
 * `panelBinding()` drives that from a component's `updated()` without the
 * component holding the two fields it used to take to remember what it opened.
 * Positioning becomes the part you can decline, with `anchor: null`.
 *
 * `ui-dialog` stays out, and should: a native `<dialog>` shown with
 * `showModal()` owns the top layer, inertness, the focus trap and the focus
 * return already, and reimplementing any of that here would be the fight
 * ADR-0029 exists to avoid. ADR-0078.
 */

import { isRtl, nextElementId } from './dom.js';

/** Breathing room kept between the panel and the edge of the viewport. */
const VIEWPORT_MARGIN = 8;

/** A panel shorter than this is not worth flipping or scrolling. */
const MIN_HEIGHT = 96;

/**
 * Why the panel is closing. `escape` also moved focus; `outside` did not.
 *
 * @typedef {'outside' | 'escape'} DismissReason
 */

/**
 * @typedef {{
 *   onDismiss: (reason: DismissReason) => void,
 *   anchor?: HTMLElement | null,
 *   align?: 'stretch' | 'start' | 'end',
 *   gap?: number,
 *   maxHeight?: number,
 * }} PanelOptions
 */

/**
 * Open `panel`: place it, announce it, and watch for the two gestures that close
 * it.
 *
 *     this.#release = openPanel(this, input, panel, {
 *       anchor: control,
 *       align: 'stretch',
 *       onDismiss: () => { this.closePanel(); },
 *     });
 *     …
 *     this.#release();
 *
 * `host` is what counts as inside: a pointer down anywhere else dismisses. It is
 * usually the element, but not always — the table's column chooser lives in a
 * toolbar strip inside a table that fills the screen, and a click on a row has to
 * close the chooser.
 *
 * `trigger` is the control that owns the panel in the accessibility tree and the
 * one focus returns to on Escape. It is also the anchor unless `anchor` says
 * otherwise: `null` leaves positioning to the consumer, and an element anchors to
 * something other than the trigger — a combobox announces its panel from the
 * `role="combobox"` input but must be as wide as the whole control around it.
 *
 * `align: 'stretch'` matches the anchor's width, which is what a select wants;
 * `'start'` and `'end'` are logical edges and follow the anchor's writing
 * direction.
 *
 * @param {HTMLElement} host
 * @param {HTMLElement} trigger
 * @param {HTMLElement} panel
 * @param {PanelOptions} options
 * @returns {() => void} Closes the panel and undoes all of the above. Idempotent.
 */
export function openPanel(host, trigger, panel, options) {
  const controller = new AbortController();
  const { signal } = controller;

  // `aria-controls` has to name an element that exists, so the id is minted here
  // rather than bound in a template that renders while the panel does not.
  panel.id ||= nextElementId('ui-panel');
  trigger.setAttribute('aria-expanded', 'true');
  trigger.setAttribute('aria-controls', panel.id);

  const anchor = options.anchor === null ? null : (options.anchor ?? trigger);
  if (anchor !== null) follow(anchor, panel, options, signal);

  // pointerdown rather than click: a click listener fires after the button is
  // released, so a drag that starts inside the panel and ends outside it would
  // close the panel mid-gesture. `composedPath` rather than `contains`, so a
  // consumer who puts a shadow-rooted element in the panel is still inside it.
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (event.composedPath().includes(host)) return;
      options.onDismiss('outside');
    },
    { signal },
  );

  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      // Focus moves before the panel does. Dismissing removes it, and focus left
      // on a removed element sends the next Tab to the top of the document.
      trigger.focus();
      options.onDismiss('escape');
    },
    { signal },
  );

  return () => {
    if (signal.aborted) return;
    controller.abort();
    conceal(panel);
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-controls');
  };
}

/**
 * @typedef {{
 *   host: HTMLElement,
 *   trigger: string,
 *   panel: string,
 *   anchor?: string | null,
 *   within?: string,
 *   align?: 'stretch' | 'start' | 'end',
 *   gap?: number,
 *   maxHeight?: number,
 *   lifetime?: () => AbortSignal,
 *   onDismiss: (reason: DismissReason) => void,
 * }} PanelBindingOptions
 */

/**
 * One component's panel, driven from `updated()` by the flag that renders it.
 *
 *     #panel = panelBinding({
 *       host: this,
 *       trigger: '[data-ui-part="menu-trigger"]',
 *       panel: '[data-ui-part="menu-panel"]',
 *       anchor: null,
 *       lifetime: () => this.lifetime,
 *       onDismiss: () => { this.open = false; },
 *     });
 *
 *     updated(changed) { …; this.#panel.sync(this.open); }
 *
 * The parts are selectors rather than elements because the element does not
 * exist until the render that opens it, and is a different element the next time.
 * That is the whole reason the two fields this replaces existed: one held the
 * release, one held the panel it belonged to, so a re-render that changed neither
 * did not tear the panel down and put it back.
 *
 * `lifetime` is read at each open rather than once, because a `SignalElement`
 * makes a new one every time it re-enters the DOM. Given it, `onDestroy` has
 * nothing to write.
 *
 * @param {PanelBindingOptions} options
 * @returns {{ sync: (open: boolean) => void, close: () => void }}
 */
export function panelBinding(options) {
  /** @type {(() => void) | undefined} */
  let release;
  /** @type {HTMLElement | null} */
  let current = null;
  let watching = false;

  /** @param {string} selector @returns {HTMLElement | null} */
  const find = (selector) => {
    const found = options.host.querySelector(selector);
    return found instanceof HTMLElement ? found : null;
  };

  const close = () => {
    release?.();
    release = undefined;
    current = null;
  };

  /** One listener per stay in the DOM, not one per open. */
  const watch = () => {
    if (watching) return;
    const signal = options.lifetime?.();
    if (signal === undefined) return;
    watching = true;
    signal.addEventListener(
      'abort',
      () => {
        watching = false;
        close();
      },
      { once: true },
    );
  };

  return {
    /** @param {boolean} open */
    sync(open) {
      const panel = open ? find(options.panel) : null;
      if (panel === current) return;
      close();
      if (panel === null) return;

      const trigger = find(options.trigger);
      if (trigger === null) return;

      /** @type {HTMLElement | null} */
      let anchor = null;
      if (options.anchor !== null) {
        anchor = options.anchor === undefined ? trigger : find(options.anchor);
        if (anchor === null) return;
      }

      const host = options.within === undefined ? options.host : find(options.within);
      if (host === null) return;

      watch();
      release = openPanel(host, trigger, panel, {
        onDismiss: options.onDismiss,
        anchor,
        align: options.align,
        gap: options.gap,
        maxHeight: options.maxHeight,
      });
      current = panel;
    },
    close,
  };
}

/**
 * Put the panel in the top layer and keep its coordinates written until `signal`
 * aborts.
 *
 * @param {HTMLElement} anchor
 * @param {HTMLElement} panel
 * @param {PanelOptions} options
 * @param {AbortSignal} signal
 */
function follow(anchor, panel, options, signal) {
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

  // Capture, because the element that scrolls is almost never the window: an
  // anchor inside a scrolling card moves with it and the panel has to follow.
  const listener = { capture: true, passive: true, signal };
  window.addEventListener('scroll', place, listener);
  window.addEventListener('resize', place, listener);

  // The panel's own size changes under it — a lazy list finishing its load, a
  // search replacing ten rows with one — and each of those moves the flip
  // decision and the clamp.
  const observer = new ResizeObserver(place);
  observer.observe(anchor);
  observer.observe(panel);
  signal.addEventListener(
    'abort',
    () => {
      observer.disconnect();
    },
    { once: true },
  );
}

/** @param {HTMLElement} panel */
function reveal(panel) {
  if (!supportsPopover(panel)) return;
  panel.popover = 'manual';
  // `manual` rather than `auto`: light dismissal would close the panel on the
  // very pointerdown that is selecting an option, and `openPanel` owns the
  // outside-click and Escape handling itself.
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
  // Every number below is a border-box number: `natural` adds the borders back on,
  // the room is measured against the anchor's own rect, and `maxHeight` is a
  // promise about how much of the viewport the panel may take. `max-height` caps
  // the content box unless this says otherwise, so without it a padded panel
  // flipped above its anchor overhangs it by its own padding. Tailwind's reset
  // happens to set this collection's panels already; the arithmetic here should
  // not depend on the consumer having one.
  style.boxSizing = 'border-box';
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
