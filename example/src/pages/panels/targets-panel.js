import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { resource } from '@core/foundation/resource.js';
import { inject } from '@core/foundation/inject.js';
import { cur, num, t } from '@core/localization/i18n.js';

import { AppNotice } from '../../ui/app-notice.js';
import { SALES_SERVICE } from '../../services/sales-service.js';

/**
 * Fetch the quarter target when the dashboard opens this panel. Native
 * `<progress>` exposes its value to assistive technology.
 */
export class TargetsPanel extends SignalElement {
  #quarter = resource(
    (signal) => inject(SALES_SERVICE).dashboard(signal).then((summary) => summary.targets.quarter),
    { initial: { attained: 0, value: 0, currency: 'EUR' }, lifetime: () => this.lifetime },
  );

  failed = this.#quarter.failed;

  get attained() {
    return this.#quarter.value.value.attained;
  }

  get percent() {
    return num(this.attained, { style: 'percent', maximumFractionDigits: 1 });
  }

  get amount() {
    const quarter = this.#quarter.value.value;
    return cur(quarter.value, quarter.currency);
  }

  get attainedAmount() {
    const quarter = this.#quarter.value.value;
    return cur(quarter.value * quarter.attained, quarter.currency);
  }

  get caption() {
    return t('dashboard.targetCaption', { attained: this.attainedAmount, target: this.amount });
  }

  onMount() {
    void this.load();
  }

  load() {
    return this.#quarter.reload();
  }
}

await defineComponent({
  tag: 'targets-panel',
  element: TargetsPanel,
  module: import.meta.url,
  uses: [AppNotice],
});
