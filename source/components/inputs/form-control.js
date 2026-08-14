/**
 * What `ui-field` needs from the thing it wraps.
 *
 * A native `<input>`, `<textarea>` or `<select>` already satisfies all of it —
 * `value`, an `input` event, a `blur` event, an assignable `id`, and attributes
 * that mean something. This module exists for the other case: a custom element
 * whose value is not a string, whose focusable node is generated inside it, and
 * whose change event has a name of its own. `ui-combobox` was exactly that, and
 * the four frictions it caused a screen wiring it by hand are what this contract
 * closes. ADR-0011.
 *
 * DUCK-TYPED, NOT A BASE CLASS
 *
 * An element implements this by having the members, not by extending anything.
 * `isFormControl` is the whole of the runtime check.
 *
 * THE CONTRACT
 *
 *   formValue          get and set. The value in whatever shape the *form* wants
 *                      — a code, a list of codes, a boolean — not the shape the
 *                      element renders. The setter must tolerate being called
 *                      before the element has its options, and apply the value
 *                      when it does; a form fills its fields from a record that
 *                      arrives before the lookup that explains it.
 *   formEvent          the event name that means "the user changed it". Bubbling
 *                      is not required; `ui-field` listens on the element.
 *   focusControl()     put focus where typing goes. `focus()` on a custom element
 *                      with no tabindex does nothing, which is why this exists.
 *   setInvalid(state)  reflect invalidity onto whatever the accessibility tree
 *                      actually sees.
 *   setDescribedBy(id) point the focusable node at the error text, or clear it
 *                      with the empty string.
 *   setLabelledBy(id)  point it at the visible label. A `<label for>` cannot
 *                      reach a node the element generates, so the association a
 *                      screen reader needs has to be made from the inside.
 *   setDisabled(state) refuse or accept editing. A native control has one
 *                      attribute for this; an element that renders its own input
 *                      and its own chips has to switch off each of them, which is
 *                      the whole reason this is the element's job and not
 *                      `ui-field`'s.
 *
 * The last four are methods rather than properties because the element usually
 * has to forward them to a node it renders rather than to itself, and a property
 * that has to be forwarded anyway is a property plus a `willUpdate`.
 */

/**
 * @typedef {object} FormControl
 * @property {unknown} formValue
 * @property {string} formEvent
 * @property {() => void} focusControl
 * @property {(invalid: boolean) => void} setInvalid
 * @property {(id: string) => void} setDescribedBy
 * @property {(id: string) => void} setLabelledBy
 * @property {(disabled: boolean) => void} setDisabled
 */

/**
 * Does this element speak the contract?
 *
 * Every member is checked rather than one of them, because a partial
 * implementation is the failure this is meant to catch: an element with
 * `formValue` and no `focusControl` would bind correctly and then swallow the
 * focus a refused submit tried to give it, which is a bug nobody notices until
 * someone uses the keyboard.
 *
 * @param {Element} element
 * @returns {element is Element & FormControl}
 */
export function isFormControl(element) {
  const candidate = /** @type {Partial<FormControl>} */ (/** @type {unknown} */ (element));
  return (
    'formValue' in element &&
    typeof candidate.formEvent === 'string' &&
    typeof candidate.focusControl === 'function' &&
    typeof candidate.setInvalid === 'function' &&
    typeof candidate.setDescribedBy === 'function' &&
    typeof candidate.setLabelledBy === 'function' &&
    typeof candidate.setDisabled === 'function'
  );
}

/**
 * The native controls `ui-field` handles without any of the above.
 *
 * `<select>` is included and `<input type="checkbox">` is not: a checkbox's value
 * is `checked`, not `value`, and pretending otherwise silently binds the string
 * `"on"` to every field. A form with one is the trigger to widen this — with a
 * real screen to design the boolean adapter against.
 *
 * @param {Element} element
 * @returns {element is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement}
 */
export function isNativeControl(element) {
  return (
    (element instanceof HTMLInputElement && element.type !== 'checkbox' && element.type !== 'radio') ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  );
}
