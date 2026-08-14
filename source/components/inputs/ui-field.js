import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { effect } from '@core/foundation/reactive.js';

import { standardText } from '../internal/text.js';
import { nextElementId, optionalAttr } from '../internal/dom.js';
import { isFormControl, isNativeControl } from './form-control.js';

/** @import { FormField } from '@core/forms/field.js' */
/** @import { FormGroup } from '@core/forms/group.js' */
/** @import { FormControl } from './form-control.js' */

/**
 * A label, a control, and the error underneath it.
 *
 *     <ui-field name="email" label="{{ t('customer.email') }}" required [.field]="form.fields.email">
 *       <input id="cf-email" type="email" class="…" />
 *     </ui-field>
 *
 * WHAT IT REPLACES
 *
 * The label, the error paragraph, the three ARIA attributes tying them together,
 * and the three bindings that wire a control to its state — 21 lines of markup per
 * field, measured. The screen writes the control and the label.
 *
 * THE CONTROL STAYS THE CALLER'S
 *
 * It is projected, not generated, so the caller writes the element they already
 * know how to write and Tailwind reaches it. ADR-0028. A native `<input>`,
 * `<textarea>` or `<select>` needs nothing; anything else must implement
 * `FormControl` — see `form-control.js` — which is how `ui-combobox` becomes usable
 * as a form field despite holding options rather than a code.
 *
 * WHY IT BINDS IMPERATIVELY
 *
 * The wiring is an `effect` and two listeners rather than template bindings,
 * because the control is a node this element did not render. That is also why it
 * is idempotent and re-runs after every update: a control behind an `*if` in the
 * caller's markup is a different element after it comes back.
 *
 * DISABLED COMES FROM THE FIELD
 *
 * There is no `disabled` attribute on this element; the state lives on the
 * `FormField`. ADR-0007. A native control gets its `disabled` property set; a
 * custom one gets `setDisabled`; the host publishes `data-disabled` so the label
 * and the error can be dimmed with it.
 *
 * ERROR TEXT
 *
 * The field carries a *code*; the sentence is resolved here. The collection's own
 * validator codes come from standard text under `ui.field.*`, so an application
 * gets sentences without configuring anything. Codes an application's server
 * invents — `taken` is the example's — come in through `messages`. Neither path
 * ships prose from this file.
 */
export class UiField extends SignalElement {
  static properties = {
    field: { attribute: false },
    messages: { attribute: false },
    name: { type: String },
    label: { type: String },
    hint: { type: String },
    required: { type: Boolean, reflect: true },
    fieldClass: { type: String, attribute: 'field-class' },
    labelClass: { type: String, attribute: 'label-class' },
    errorClass: { type: String, attribute: 'error-class' },
    hintClass: { type: String, attribute: 'hint-class' },
  };

  /**
   * The state this field edits. Everything on screen is derived from it.
   *
   * @type {FormField<any> | null}
   */
  field = null;

  /**
   * Error codes this application's server can send, to sentences. Consulted
   * before standard text, so it can also override a collection message for one
   * field — "This name is required" where the generic one is too vague.
   *
   * @type {Readonly<Record<string, string>>}
   */
  messages = {};

  /** The key this field has in its group. What `focusInvalidField` matches on. */
  name = '';

  label = '';
  hint = '';
  required = false;

  fieldClass = '';
  labelClass = '';
  errorClass = '';
  hintClass = '';

  /** @type {(HTMLElement & Partial<FormControl>) | null} */
  #control = null;

  /**
   * The field the current wiring reads.
   *
   * `field` is a Lit property rather than a signal, so the effect below has no
   * reactive dependency on *which* field it is looking at — only on what that
   * field contains. Rebinding therefore has to be noticed here, and a form that
   * swaps a field without it goes on editing the previous one.
   *
   * @type {FormField<any> | null}
   */
  #bound = null;

  /** @type {AbortController | undefined} */
  #listeners;

  /** @type {(() => void) | undefined} */
  #stopWatching;

  #labelId = nextElementId('ui-field-label');

  /** Falls back to a generated id only when the caller's control has none. */
  #generatedControlId = nextElementId('ui-field-control');

  /* ── Template surface ───────────────────────────────────────────────────── */

  get labelId() {
    return this.#labelId;
  }

  /**
   * `for` names the control only when the control is one a label may name. A
   * `for` pointing at a custom element is invalid HTML and, worse, silently does
   * nothing; the custom path is `setLabelledBy` instead.
   */
  get labelFor() {
    return optionalAttr(this.#control !== null && isNativeControl(this.#control) ? this.#controlId : '');
  }

  get errorId() {
    return `${this.#controlId}-error`;
  }

  get hintId() {
    return `${this.#controlId}-hint`;
  }

  /** The sentence for the current code, or the empty string when there is none to show. */
  get errorText() {
    const code = this.field?.visibleError.value ?? '';
    if (code === '') return '';
    return this.messages[code] ?? standardText('field', code);
  }

  get showHint() {
    return this.hint !== '' && this.errorText === '';
  }

  /* ── Wiring ─────────────────────────────────────────────────────────────── */

  onMount() {
    this.#attach();
  }

  /** @param {Map<PropertyKey, unknown>} changed */
  updated(changed) {
    // `super.updated` is what projects the caller's control into place, so the
    // control cannot be looked for before it has run.
    super.updated(changed);
    this.#attach();
  }

  onDestroy() {
    this.#stopWatching?.();
    this.#stopWatching = undefined;
    this.#listeners?.abort();
    this.#listeners = undefined;
    this.#control = null;
  }

  /** Put focus where typing goes. What a refused submit calls. */
  focusControl() {
    const control = this.#control;
    if (control === null) return;
    if (isFormControl(control)) control.focusControl();
    else control.focus();
  }

  /**
   * Find the projected control and bind it. Idempotent: the common case is that
   * nothing changed and this returns after one comparison.
   */
  #attach() {
    const found = this.#findControl();
    if (found === this.#control && this.field === this.#bound) {
      // Same element, but its id or the label may have arrived with this render.
      if (found !== null) this.#describe(found);
      return;
    }

    this.#stopWatching?.();
    this.#listeners?.abort();
    this.#control = found;
    this.#bound = this.field;
    if (found === null) return;

    const listeners = new AbortController();
    this.#listeners = listeners;
    const changeEvent = isFormControl(found) ? found.formEvent : 'input';

    found.addEventListener(
      changeEvent,
      () => {
        if (this.field !== null) this.field.setValue(this.#read(found));
      },
      { signal: listeners.signal },
    );

    // Capture, because `blur` does not bubble: a listener on this element would
    // never hear the control's, and a control that generates its own focusable
    // node does not fire one on itself at all.
    found.addEventListener('blur', () => this.field?.touch(), { signal: listeners.signal, capture: true });

    this.#describe(found);

    // One effect for all three outputs. They change together — a value written
    // back after a reset, an error appearing, the control's id being pointed at
    // it — and three effects would be three subscriptions to the same field.
    this.#stopWatching = effect(() => {
      const field = this.field;
      if (field === null) return;
      this.#write(found, field.value.value);
      const invalid = field.visibleError.value !== '';
      const describedBy = invalid ? this.errorId : this.showHint ? this.hintId : '';
      const disabled = field.disabled.value;
      if (isFormControl(found)) {
        found.setInvalid(invalid);
        found.setDescribedBy(describedBy);
        found.setDisabled(disabled);
      } else {
        found.setAttribute('aria-invalid', String(invalid));
        if (describedBy === '') found.removeAttribute('aria-describedby');
        else found.setAttribute('aria-describedby', describedBy);
        // The property, not the attribute: `disabled=""` and `disabled="false"`
        // are both disabled, and a control the caller wrote with the attribute
        // already on it would then never come back.
        if (isNativeControl(found)) found.disabled = disabled;
      }
      // State for a stylesheet, the same way the shell elements publish theirs —
      // the label and the error are this element's markup, so a caller dimming a
      // switched-off field has nothing else to hang a selector on.
      this.toggleAttribute('data-disabled', disabled);
    });
  }

  /**
   * The first projected element that can hold a value.
   *
   * A query rather than a slot assignment, because the control is one of the
   * caller's nodes and this element must not care whether it is wrapped in a
   * `<div>` for layout.
   *
   * @returns {(HTMLElement & Partial<FormControl>) | null}
   */
  #findControl() {
    for (const candidate of this.querySelectorAll('*')) {
      if (isNativeControl(candidate) || isFormControl(candidate)) {
        return /** @type {HTMLElement & Partial<FormControl>} */ (candidate);
      }
    }
    return null;
  }

  /** @param {HTMLElement & Partial<FormControl>} control */
  #describe(control) {
    if (control.id === '') control.id = this.#generatedControlId;
    if (isFormControl(control)) control.setLabelledBy(this.label === '' ? '' : this.#labelId);
  }

  /** @returns {string} The control's id, whether the caller gave it one or this element did. */
  get #controlId() {
    return this.#control?.id === undefined || this.#control.id === ''
      ? this.#generatedControlId
      : this.#control.id;
  }

  /**
   * @param {HTMLElement & Partial<FormControl>} control
   * @returns {unknown}
   */
  #read(control) {
    if (isFormControl(control)) return control.formValue;
    return isNativeControl(control) ? control.value : '';
  }

  /**
   * @param {HTMLElement & Partial<FormControl>} control
   * @param {unknown} value
   */
  #write(control, value) {
    if (isFormControl(control)) {
      control.formValue = value;
      return;
    }
    if (!isNativeControl(control)) return;
    // Only the shapes a native control can actually hold. Anything else is a
    // field bound to the wrong kind of control, and writing `[object Object]`
    // into it would hide that behind a value that looks almost plausible.
    const next = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
    // Compared first, because assigning `value` moves the caret to the end in
    // every browser — including when the assignment changes nothing, which is
    // every keystroke if this is unconditional.
    if (control.value !== next) control.value = next;
  }
}

/**
 * Focus the field a refused submit should send the user to, and report whether
 * there was one.
 *
 *     if (!this.form.markSubmitted()) return void focusInvalidField(this, this.form);
 *
 * The server's answer wins over a client rule, because a 422 is about a value the
 * user has just been told is fine and is the more surprising of the two.
 *
 * @param {ParentNode} root Where to look — usually the screen itself.
 * @param {FormGroup<any>} group
 * @returns {boolean} Whether a field was found to focus.
 */
export function focusInvalidField(root, group) {
  const name = group.firstServerError === '' ? group.firstInvalid.value : group.firstServerError;
  if (name === '') return false;

  const field = root.querySelector(`ui-field[name="${CSS.escape(name)}"]`);
  if (!(field instanceof UiField)) return false;
  field.focusControl();
  return true;
}

await defineComponent({ tag: 'ui-field', element: UiField, module: import.meta.url });
