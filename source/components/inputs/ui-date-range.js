import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { standardText } from '../internal/text.js';
import { optionalAttr } from '../internal/dom.js';
import { RANGE_SEPARATOR } from '../data/filter-descriptor.js';

/**
 * Separates the two halves of a stored range.
 *
 * Kept as the original's `' to '` rather than something tidier, because the
 * string crosses the wire: a backend already splitting on it keeps working, and
 * a filter persisted by the Angular application restores here unchanged.
 *
 * Defined in `filter-descriptor.js` and re-exported here, because the string is
 * the format of a range *filter value*: the code that decides whether a row falls
 * in a range has to split it too, and two components splitting on two copies of a
 * separator is one edit away from a filter that matches nothing.
 */
export const DATE_RANGE_SEPARATOR = RANGE_SEPARATOR;

/**
 * Two day fields and a confirm, for picking one `since to until` string.
 *
 *     <ui-date-range
 *       .range=${current}
 *       @range-confirm=${(event) => apply(event.detail)}
 *       @range-cancel=${() => close()}
 *     ></ui-date-range>
 *
 * INLINE, NOT A MODAL, WHICH IS THE ONE DESIGN DECISION HERE
 *
 * Rendered inline under its own row, the editor is where the pointer already is,
 * dismissing it costs an Escape, and the component carries no pending state at
 * all: a value in, an event out.
 *
 * THE HALF-OPEN INTERVAL, WHICH IS THE ONLY SUBTLE THING HERE
 *
 * The stored `until` is EXCLUSIVE, because the query behind it is
 * `since <= x < until` and that is the form that does not lose the last day to a
 * timestamp of 14:32. The user is never shown it. Both inputs work in inclusive
 * days — "to the 31st" means the 31st is in — and the conversion happens on the
 * way in and on the way out, in one place, here.
 *
 * Two `<input type="date">` rather than a calendar library. The native control
 * brings its own locale, keyboard handling and mobile picker, and loses only the
 * two-month range highlight. Reopen that choice if a product need appears for a
 * two-month range highlight, or for date semantics the native control cannot
 * express; the cost is a vendored dependency and its integrity pin.
 *
 * No text is shipped. Every label is standard text from `ui.dateRange.*`,
 * resolved through `text.js`: an editor that says "From", "To", "Apply" and
 * "Cancel" says the same four things on every screen that opens one.
 */
export class UiDateRange extends SignalElement {
  static properties = {
    range: { type: String },
    since: { state: true },
    until: { state: true },
    invalid: { state: true },
    autoFocus: { type: Boolean, attribute: 'auto-focus' },
    min: { type: String },
    max: { type: String },
    formClass: { type: String, attribute: 'form-class' },
  };

  /** The current value, in stored (exclusive) form. Empty starts blank. */
  range = '';

  /** `YYYY-MM-DD`, inclusive. */
  since = '';

  /** `YYYY-MM-DD`, inclusive — the last day the user wants counted. */
  until = '';

  invalid = false;

  /** Takes focus once, on the first render. What an inline editor wants. */
  autoFocus = false;

  min = '';
  max = '';
  formClass = '';

  /** @type {string | undefined} */
  #adopted;

  #focused = false;

  /**
   * The incoming range is split into the two inclusive days the fields show, and
   * only when it actually changes: re-splitting on every render would overwrite
   * what the user is halfway through typing.
   */
  willUpdate() {
    if (this.range === this.#adopted) return;
    this.#adopted = this.range;
    const [since, untilExclusive] = splitRange(this.range);
    this.since = since;
    this.until = untilExclusive === '' ? '' : shiftDay(untilExclusive, -1);
    this.invalid = false;
  }

  /** @param {Map<PropertyKey, unknown>} changed */
  updated(changed) {
    super.updated(changed);
    if (!this.autoFocus || this.#focused) return;
    this.#focused = true;
    /** @type {HTMLInputElement | null} */ (
      this.querySelector('[data-ui-part="date-range-since"]')
    )?.focus();
  }

  /**
   * Standard interaction text, from `ui.dateRange.*`. See `text.js`.
   *
   * @param {string} name
   * @returns {string}
   */
  text(name) {
    return standardText('dateRange', name);
  }

  get minAttr() {
    return optionalAttr(this.min);
  }

  get maxAttr() {
    return optionalAttr(this.max);
  }

  /** The end may not precede the start; ISO day strings compare as text. */
  get isValid() {
    return this.since !== '' && this.until !== '' && this.until >= this.since;
  }

  /** @param {Event} event */
  onSinceInput(event) {
    if (!(event.target instanceof HTMLInputElement)) return;
    this.since = event.target.value;
    this.invalid = false;
  }

  /** @param {Event} event */
  onUntilInput(event) {
    if (!(event.target instanceof HTMLInputElement)) return;
    this.until = event.target.value;
    this.invalid = false;
  }

  /**
   * Enter in either field confirms, which is what a two-field form owes the
   * keyboard. `preventDefault` because there is nowhere to submit to.
   *
   * @param {Event} event
   */
  onSubmit(event) {
    event.preventDefault();
    this.confirm();
  }

  /**
   * Escape dismisses, and stops there. Left to bubble it would also reach the
   * panel this editor is rendered inside and close that too, losing the dropdown
   * along with the range.
   *
   * @param {KeyboardEvent} event
   */
  onKeydown(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    this.cancel();
  }

  confirm() {
    if (!this.isValid) {
      this.invalid = true;
      return;
    }
    // Back to the exclusive end the rest of the system stores. A single day
    // becomes the interval [day, day + 1).
    this.#emit('range-confirm', `${this.since}${DATE_RANGE_SEPARATOR}${shiftDay(this.until, 1)}`);
  }

  cancel() {
    this.#emit('range-cancel', undefined);
  }

  /** @param {'range-confirm' | 'range-cancel'} name @param {string | undefined} detail */
  #emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, detail }));
  }
}

/**
 * @param {string} [range]
 * @returns {[string, string]}
 */
function splitRange(range) {
  if (range === undefined || range === '') return ['', ''];
  const [since, until] = range.split(DATE_RANGE_SEPARATOR);
  if (since === undefined || until === undefined) return ['', ''];
  return [since, until];
}

/**
 * Move a `YYYY-MM-DD` day by whole days, staying date-only and local. Parsing the
 * parts by hand rather than `new Date(string)`, which reads a bare ISO day as
 * UTC and hands back yesterday to anyone west of Greenwich.
 *
 * @param {string} day @param {number} delta
 */
export function shiftDay(day, delta) {
  const [year, month, date] = day.split('-').map(Number);
  if (year === undefined || month === undefined || date === undefined) return day;
  const moved = new Date(year, month - 1, date + delta);
  return `${String(moved.getFullYear()).padStart(4, '0')}-${String(moved.getMonth() + 1).padStart(2, '0')}-${String(moved.getDate()).padStart(2, '0')}`;
}

/**
 * The stored range as the two inclusive days a person would name.
 *
 * @param {unknown} range
 * @returns {{ since: string, until: string, singleDay: boolean } | undefined}
 */
export function readRange(range) {
  if (typeof range !== 'string' || range === '') return undefined;
  const [since, untilExclusive] = range.split(DATE_RANGE_SEPARATOR);
  if (since === undefined || untilExclusive === undefined) return undefined;
  const until = shiftDay(untilExclusive, -1);
  return { since, until, singleDay: since === until };
}

await defineComponent({ tag: 'ui-date-range', element: UiDateRange, module: import.meta.url });
