import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';

/**
 * Render a titled surface with optional lead text, toolbar, and projected body.
 * Screens pass translated text through `heading` and `lead`.
 */
export class AppCard extends SignalElement {
  static properties = {
    heading: { type: String },
    lead: { type: String },
    eyebrow: { type: String },
/** Remove body padding for full-width content. */
    flush: { type: Boolean, reflect: true },
  };

  heading = '';
  lead = '';
  eyebrow = '';
  flush = false;

  get bodyClasses() {
    return this.flush ? '' : 'px-5 py-4';
  }
}

await defineComponent({ tag: 'app-card', element: AppCard, module: import.meta.url, styles: true });
