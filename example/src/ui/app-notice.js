import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';

/**
 * What a screen says while it is loading, and what it says when the request failed.
 *
 * Every screen in this application has the same three non-happy states — busy, failed,
 * nothing to show — and each of them was three lines of markup per screen before this
 * existed. Now they are one element, and the wording still belongs to the caller: a
 * component that spelled "Loading…" itself could not be rendered in Arabic.
 *
 * `action` and the `action` event are how a failure offers a retry without this element
 * knowing what retrying means.
 */
export class AppNotice extends SignalElement {
  static properties = {
    variant: { type: String, reflect: true },
    message: { type: String },
    /** Label of the optional button. Empty means no button. */
    action: { type: String },
  };

  /** @type {'loading' | 'error' | 'empty'} */
  variant = 'loading';
  message = '';
  action = '';

  get toneClasses() {
    switch (this.variant) {
      case 'error':
        return 'border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200';
      case 'empty':
        return 'border-ui-border bg-canvas text-muted';
      default:
        return 'border-ui-border bg-canvas text-muted';
    }
  }

  get busy() {
    return this.variant === 'loading';
  }

  /**
   * A live region for the busy state only. An error is announced by the assertive
   * region below; making both polite means a failed request says nothing at all to a
   * screen reader that was not looking there.
   */
  get liveness() {
    return this.variant === 'error' ? 'assertive' : 'polite';
  }

  emitAction() {
    this.dispatchEvent(new CustomEvent('action', { bubbles: true }));
  }
}

await defineComponent({ tag: 'app-notice', element: AppNotice, module: import.meta.url });
