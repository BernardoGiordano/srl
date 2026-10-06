import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { cur, num, t } from '@core/localization/i18n.js';

import { iconPath } from '../icons.js';

/**
 * Format a KPI value and its change for the active locale. `currency` names the
 * amount's currency; `delta` is a signed fraction, such as 0.062 for 6.2%.
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
    /** Name of an icon in icons.js. Empty means no icon. */
    icon: { type: String },
  };

  label = '';
  value = 0;
  currency = '';
  delta = Number.NaN;
  hint = '';
  icon = '';

  get formattedValue() {
    return this.currency === '' ? num(this.value) : cur(this.value, this.currency);
  }

  get iconData() {
    return iconPath(this.icon);
  }

  get hasDelta() {
    return Number.isFinite(this.delta);
  }

  get formattedDelta() {
    // Let the locale format the sign as well as the number.
    return num(this.delta, { style: 'percent', maximumFractionDigits: 1, signDisplay: 'always' });
  }

  get deltaClasses() {
    if (this.delta > 0) return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400';
    if (this.delta < 0) return 'bg-rose-500/10 text-rose-700 dark:text-rose-400';
    return 'bg-canvas text-muted';
  }

  /** The accessible description of the movement, as a full sentence. */
  get deltaLabel() {
    return t(this.delta < 0 ? 'stat.down' : 'stat.up', { value: this.formattedDelta });
  }
}

await defineComponent({ tag: 'app-stat', element: AppStat, module: import.meta.url, styles: true });
