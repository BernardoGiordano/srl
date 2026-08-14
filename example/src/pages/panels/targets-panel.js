import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { signal } from '@core/foundation/reactive.js';
import { inject } from '@core/foundation/inject.js';
import { cur, num, t } from '@core/localization/i18n.js';

import { AppNotice } from '../../ui/app-notice.js';
import { SALES_SERVICE } from '../../services/sales-service.js';

/**
 * The quarter's target, as a meter.
 *
 * The panel fetches its own data rather than receiving it, which is the point of it
 * being a separate lazily loaded module: nothing about the quarter target is
 * downloaded, requested or rendered until somebody asks for this panel. The dashboard
 * that mounts it knows only how to load it.
 *
 * `<progress>` rather than a div with a width: it is a native meter with a native
 * accessible value, and styling it costs less than reimplementing what it announces.
 */
export class TargetsPanel extends SignalElement {
  attained = signal(0);
  value = signal(0);
  currency = signal('EUR');
  failed = signal(false);

  /** @type {AbortController | undefined} */
  #request;

  get percent() {
    return num(this.attained.value, { style: 'percent', maximumFractionDigits: 1 });
  }

  get amount() {
    return cur(this.value.value, this.currency.value);
  }

  get attainedAmount() {
    return cur(this.value.value * this.attained.value, this.currency.value);
  }

  get caption() {
    return t('dashboard.targetCaption', { attained: this.attainedAmount, target: this.amount });
  }

  onMount() {
    void this.load();
  }

  onDestroy() {
    this.#request?.abort();
    this.#request = undefined;
  }

  async load() {
    this.#request?.abort();
    const request = new AbortController();
    this.#request = request;
    this.failed.value = false;

    try {
      const summary = await inject(SALES_SERVICE).dashboard(request.signal);
      if (request.signal.aborted) return;
      this.attained.value = summary.targets.quarter.attained;
      this.value.value = summary.targets.quarter.value;
      this.currency.value = summary.targets.quarter.currency;
    } catch {
      if (!request.signal.aborted) this.failed.value = true;
    } finally {
      if (this.#request === request) this.#request = undefined;
    }
  }
}

await defineComponent({
  tag: 'targets-panel',
  element: TargetsPanel,
  module: import.meta.url,
  uses: [AppNotice],
});
