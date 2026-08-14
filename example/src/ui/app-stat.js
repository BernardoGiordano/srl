import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { cur, num, t } from '@core/localization/i18n.js';

/**
 * One KPI tile: a label, a number, and how it moved.
 *
 * The formatting is the point. `value` arrives as a number and `currency` as a code,
 * and the tile renders it through `cur()` or `num()` — both memoised per locale and
 * both reactive — so switching to Italian re-renders `1.234,50 €` from the same
 * property with no work anywhere else. Currency stays a property of the amount rather
 * than of the locale, which is the mistake that makes an English page render euros as
 * dollars.
 *
 * `delta` is a fraction, not a percentage: 0.062 renders as +6.2%, and the sign
 * decides the colour. A tile that received a pre-formatted string could do none of
 * this, which is why no server in this example ever sends one.
 */
export class AppStat extends SignalElement {
  static properties = {
    label: { type: String },
    value: { type: Number },
    /** ISO 4217 code. Empty means the value is a count, not money. */
    currency: { type: String },
    /** Signed fraction of change, or NaN for "no comparison". */
    delta: { type: Number },
    hint: { type: String },
  };

  label = '';
  value = 0;
  currency = '';
  delta = Number.NaN;
  hint = '';

  get formattedValue() {
    return this.currency === '' ? num(this.value) : cur(this.value, this.currency);
  }

  get hasDelta() {
    return Number.isFinite(this.delta);
  }

  get formattedDelta() {
    // `signDisplay: 'always'` rather than a hand-written '+': the sign is a property
    // of the locale's number formatting, and Arabic does not spell it with an ASCII
    // plus.
    return num(this.delta, { style: 'percent', maximumFractionDigits: 1, signDisplay: 'always' });
  }

  get deltaClasses() {
    if (this.delta > 0) return 'text-emerald-600 dark:text-emerald-400';
    if (this.delta < 0) return 'text-rose-600 dark:text-rose-400';
    return 'text-muted';
  }

  /** The accessible description of the movement, as a full sentence. */
  get deltaLabel() {
    return t(this.delta < 0 ? 'stat.down' : 'stat.up', { value: this.formattedDelta });
  }
}

await defineComponent({ tag: 'app-stat', element: AppStat, module: import.meta.url });
