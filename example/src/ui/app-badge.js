import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';

/**
 * Map a status tone to its utility classes. Callers project the translated label.
 */
export class AppBadge extends SignalElement {
  static properties = {
    tone: { type: String, reflect: true },
  };

  /** @type {'neutral' | 'info' | 'good' | 'warn' | 'bad'} */
  tone = 'neutral';

  get toneClasses() {
    switch (this.tone) {
      case 'info':
        return 'bg-sky-50 text-sky-700 ring-sky-600/15 dark:bg-sky-400/10 dark:text-sky-300 dark:ring-sky-400/20';
      case 'good':
        return 'bg-emerald-50 text-emerald-700 ring-emerald-600/15 dark:bg-emerald-400/10 dark:text-emerald-300 dark:ring-emerald-400/20';
      case 'warn':
        return 'bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-400/10 dark:text-amber-300 dark:ring-amber-400/20';
      case 'bad':
        return 'bg-rose-50 text-rose-700 ring-rose-600/15 dark:bg-rose-400/10 dark:text-rose-300 dark:ring-rose-400/20';
      default:
        return 'bg-canvas text-muted ring-ui-border';
    }
  }
}

await defineComponent({ tag: 'app-badge', element: AppBadge, module: import.meta.url, styles: true });
