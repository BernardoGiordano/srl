import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';

import { standardText } from '../internal/text.js';
import { nextElementId } from '../internal/dom.js';

/** @import { FormNode } from '@core/forms/types.js' */

/**
 * The message for a rule about a set of values rather than one of them.
 *
 *     <ui-form-error name="period" [.node]="form.fields.period"
 *                    error-class="…"></ui-form-error>
 *
 * It is not `ui-field`. `ui-field` is a label, a projected control and the error
 * under it, and almost all of it is control wiring, from the projection query and
 * the blur listener to the value write-back, `aria-describedby` and the disabled
 * property. A group has no control, so every one of those would be dead. This
 * element is the half that is left. ADR-0102.
 *
 * The code comes from `node.visibleError`, which is a `FormGroup`'s or a
 * `FormArray`'s own code once the timing rule allows it, meaning after a submit or
 * once every member has been visited. The vocabulary is the one `ui-field`
 * resolves, `ui.field.*`, so `ordered()` and `required()` are sentences from the
 * same bundle.
 *
 * A `FormField` works here too and shows the field's own error without a control
 * beside it. Rare, and not the reason this exists.
 *
 * `name` is the path of the node this displays, which is what `focusInvalidField`
 * matches on. That is the empty string for the form itself, `period` for a nested
 * group, `contacts` for an array. The element takes focus programmatically, so a
 * refused submit has somewhere to send the user when the rule that refused it
 * belongs to no single control.
 */
export class UiFormError extends SignalElement {
  static properties = {
    node: { attribute: false },
    messages: { attribute: false },
    name: { type: String },
    errorClass: { type: String, attribute: 'error-class' },
  };

  /**
   * The node whose error this shows. Usually a `FormGroup` or a `FormArray`.
   *
   * @type {FormNode | null}
   */
  node = null;

  /**
   * Error codes this application's server or its own validators can produce, to
   * sentences. Consulted before standard text, exactly as on `ui-field`.
   *
   * @type {Readonly<Record<string, string>>}
   */
  messages = {};

  /** This node's path, as `invalidPath` reports it. Empty for the form itself. */
  name = '';

  errorClass = '';

  #errorId = nextElementId('ui-form-error');

  get errorId() {
    return this.#errorId;
  }

  /** The sentence for the current code, or the empty string when there is none. */
  get errorText() {
    const code = this.node?.visibleError.value ?? '';
    if (code === '') return '';
    return this.messages[code] ?? standardText('field', code);
  }

  onMount() {
    // Focusable by script rather than by tab. The message is not a stop on the
    // way through the form, but a refused submit has to be able to land on it.
    if (!this.hasAttribute('tabindex')) this.tabIndex = -1;
  }

  /** Put focus here. The same call `ui-field` answers, so one loop finds either. */
  focusControl() {
    this.focus();
  }
}

await defineComponent({ tag: 'ui-form-error', element: UiFormError, module: import.meta.url });
