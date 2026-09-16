import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';

/**
 * Pair a translated label with projected detail content. `aria-labelledby`
 * associates the label and value across the custom element boundary.
 */
export class AppField extends SignalElement {
  static properties = {
    label: { type: String },
  };

  label = '';

  /** @type {string | undefined} */
  #id;

  /** A stable id per instance, generated once, for `aria-labelledby`. */
  get labelId() {
    this.#id ??= `field-${String(counter++)}`;
    return this.#id;
  }
}

let counter = 0;

await defineComponent({ tag: 'app-field', element: AppField, module: import.meta.url, styles: true });
