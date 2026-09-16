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
        return 'bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300';
      case 'good':
        return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300';
      case 'warn':
        return 'bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-300';
      case 'bad':
        return 'bg-rose-100 text-rose-800 dark:bg-rose-500/15 dark:text-rose-300';
      default:
        return 'bg-canvas text-muted';
    }
  }
}

await defineComponent({ tag: 'app-badge', element: AppBadge, module: import.meta.url, styles: true });
