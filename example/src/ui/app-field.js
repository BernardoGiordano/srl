import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';

/**
 * A label and its value, for the detail screens.
 *
 * The value is projected rather than passed as an attribute, because half of them are
 * not text: a status pill, a link to a customer, a formatted amount with a currency
 * beside it. The label is an attribute, because it always is text and it always comes
 * from `t()`.
 *
 * Rendered as a `<div>` pair rather than `<dt>`/`<dd>`: a description list requires its
 * children to be exactly those elements, and this component cannot be one of them
 * while also being a custom element in between. The label is associated with the value
 * through `aria-labelledby` instead, which is what a screen reader needs and what the
 * markup shape cannot give here.
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

await defineComponent({ tag: 'app-field', element: AppField, module: import.meta.url });
