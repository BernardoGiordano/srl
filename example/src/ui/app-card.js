import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';

/**
 * The panel every screen in this application is made of: a titled surface with an
 * optional lead paragraph, an optional toolbar and a body.
 *
 * Everything except the title comes in as projected content, so a screen composes
 * with native slot syntax in light DOM and Tailwind reaches inside:
 *
 *     <app-card heading="{{ t('orders.title') }}" lead="{{ t('orders.lead') }}">
 *       <ui-dynamic-filter slot="toolbar" …></ui-dynamic-filter>
 *       <ui-table …></ui-table>
 *     </app-card>
 *
 * `heading` and `lead` are attributes rather than slots because they are text, and a
 * screen passing `t('…')` into an attribute is how a string follows a language
 * change. `eyebrow` names the section above the heading, which is what makes a card
 * readable when four of them are on one screen.
 *
 * This is one of the components in this example that would move into
 * `source/components` if a second application wanted it — it imports nothing from
 * `@app/`, reads no injector token and contains no English. It stays here until
 * there is a second consumer, because a component with one caller is a component
 * whose interface has not been tested.
 */
export class AppCard extends SignalElement {
  static properties = {
    heading: { type: String },
    lead: { type: String },
    eyebrow: { type: String },
    /** Removes the body padding, for a card whose body is a full-bleed table. */
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

await defineComponent({ tag: 'app-card', element: AppCard, module: import.meta.url });
