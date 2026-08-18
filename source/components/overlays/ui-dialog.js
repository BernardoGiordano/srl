import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';

import { optionalAttr } from '../internal/dom.js';

/**
 * A modal: a panel over the page, with everything behind it out of reach.
 *
 *     <ui-dialog
 *       alert
 *       mandatory
 *       [.open]="askingToLeave"
 *       label="{{ t('customerForm.discardTitle') }}"
 *       panel-class="w-full max-w-md rounded-xl border p-5"
 *       (close)="keepEditing()"
 *     >
 *       …heading, prose and the buttons that answer it…
 *     </ui-dialog>
 *
 * WHY THIS IS A NATIVE `<dialog>`
 *
 * Top layer, an inert page behind it, a real `::backdrop` and focus return are all
 * specified and implemented; a `role="dialog"` div re-implements four of them
 * badly and the fifth not at all. ADR-0029. `aria-modal` is deliberately absent:
 * `showModal()` already matches `:modal`, and the attribute is the version of that
 * claim which can be wrong.
 *
 * `open` IS THE CONSUMER'S
 *
 * Escape and a backdrop click do not close anything by themselves. They ask —
 * `cancel` is always prevented — and the element answers by lowering its own
 * `open` and emitting `close`, so a screen that binds `[.open]` stays the single
 * source of truth. `mandatory` refuses even to ask, which is the case a discard
 * prompt needs. ADR-0030.
 *
 * WHAT IT LEAVES TO THE CONSUMER
 *
 * Every word and every class inside the panel, and the panel's own box through
 * `panel-class`. What it keeps is the layer: full-viewport, centred, transparent —
 * the one place this collection's stylesheet claims layout, and see the note in
 * `style.css` for why.
 */
export class UiDialog extends SignalElement {
  static properties = {
    // Reflected as `data-*` rather than as a bare `open`, which is a real
    // boolean attribute of `<dialog>`: two elements in one subtree carrying the
    // same attribute name for two different states is the sort of thing that
    // typechecks and then confuses everyone reading the DOM.
    open: { type: Boolean, reflect: true, attribute: 'data-open' },
    alert: { type: Boolean },
    mandatory: { type: Boolean },
    label: { type: String },
    panelClass: { type: String, attribute: 'panel-class' },
  };

  /** Whether the dialog is showing. The consumer's state, bound in. */
  open = false;

  /**
   * `role="alertdialog"` rather than `dialog`, for a message that interrupts
   * rather than a surface the user opened. Assistive technology announces the
   * whole panel on arrival instead of just its name.
   */
  alert = false;

  /** No Escape, no backdrop dismissal: the projected buttons are the only way out. */
  mandatory = false;

  /** Accessible name for the dialog. */
  label = '';

  /** Classes for the panel — its width, padding, radius and border. */
  panelClass = '';

  /* ── Template surface ───────────────────────────────────────────────────── */

  get roleAttr() {
    return optionalAttr(this.alert ? 'alertdialog' : '');
  }

  get labelAttr() {
    return optionalAttr(this.label);
  }

  /* ── Showing and hiding ─────────────────────────────────────────────────── */

  /**
   * `updated` rather than an effect on a signal: `open` is a Lit property, and
   * this has to run *after* the render that projected the consumer's content into
   * the panel. `showModal()` moves focus to the first focusable thing it finds,
   * and a dialog shown before its buttons exist finds nothing.
   *
   * @param {Map<PropertyKey, unknown>} changed
   */
  updated(changed) {
    super.updated(changed);
    const dialog = this.#dialog;
    if (dialog === null) return;
    if (this.open && !dialog.open) this.#show(dialog);
    else if (!this.open && dialog.open) this.#hide(dialog);
  }

  onDestroy() {
    // A dialog destroyed while open never fires `close`, and the scroll lock it
    // took would outlive the page that took it.
    const dialog = this.#dialog;
    if (dialog !== null && dialog.open) this.#hide(dialog);
  }

  /** Lower `open` and say so. What Escape and a backdrop click go through. */
  close() {
    if (!this.open) return;
    this.open = false;
    this.dispatchEvent(new CustomEvent('close'));
  }

  /**
   * Escape. Always prevented — see the note on `open` — and then treated as a
   * dismissal unless this dialog is one that must be answered.
   *
   * @param {Event} event
   */
  onCancel(event) {
    event.preventDefault();
    if (!this.mandatory) this.close();
  }

  /**
   * A click on the layer rather than on the panel, which is what a click on the
   * backdrop is: the panel is the dialog's only child, so any click whose target
   * is still the dialog itself landed beside it.
   *
   * @param {Event} event
   */
  onLayerClick(event) {
    if (this.mandatory || event.target !== this.#dialog) return;
    this.close();
  }

  /** @returns {HTMLDialogElement | null} */
  get #dialog() {
    const found = this.querySelector('dialog');
    return found instanceof HTMLDialogElement ? found : null;
  }

  /** @param {HTMLDialogElement} dialog */
  #show(dialog) {
    dialog.showModal();
    lockScroll();
  }

  /** @param {HTMLDialogElement} dialog */
  #hide(dialog) {
    dialog.close();
    unlockScroll();
  }
}

/**
 * The document does not stop scrolling behind a modal dialog, which is the one
 * thing `showModal()` leaves out: the page under the backdrop is inert to the
 * keyboard and to a pointer, and still scrolls under a wheel.
 *
 * Counted rather than set and cleared, because a dialog opened from a dialog
 * would otherwise release the lock the first one is still holding.
 */
let openModals = 0;
let restoreOverflow = '';

function lockScroll() {
  openModals += 1;
  if (openModals > 1) return;
  restoreOverflow = document.documentElement.style.overflow;
  document.documentElement.style.overflow = 'hidden';
}

function unlockScroll() {
  if (openModals === 0) return;
  openModals -= 1;
  if (openModals > 0) return;
  document.documentElement.style.overflow = restoreOverflow;
}

await defineComponent({ tag: 'ui-dialog', element: UiDialog, module: import.meta.url });
