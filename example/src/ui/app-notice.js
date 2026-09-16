import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';

/**
 * Show loading, error, or empty states with caller-supplied text. The optional
 * action emits an event so the caller can retry.
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
   * Announce loading politely. The error uses the assertive region below.
   */
  get liveness() {
    return this.variant === 'error' ? 'assertive' : 'polite';
  }

  emitAction() {
    this.dispatchEvent(new CustomEvent('action', { bubbles: true }));
  }
}

await defineComponent({ tag: 'app-notice', element: AppNotice, module: import.meta.url, styles: true });
