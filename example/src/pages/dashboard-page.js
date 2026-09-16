import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { ComponentOutlet } from '@core/elements/outlet.js';
import { signal } from '@core/foundation/reactive.js';
import { resource } from '@core/foundation/resource.js';
import { inject } from '@core/foundation/inject.js';
import { dt, t } from '@core/localization/i18n.js';

import { AppCard } from '../ui/app-card.js';
import { AppStat } from '../ui/app-stat.js';
import { AppNotice } from '../ui/app-notice.js';
import { SALES_SERVICE } from '../services/sales-service.js';

/** @import { DashboardSummary } from '../services/sales-service.js' */
/** @import { OutletTarget } from '@core/elements/types.js' */

/**
 * Show KPIs, alerts, and a chosen panel. The tiles format numeric API values for
 * the active locale. The outlet follows the panel signal, while a resource owns
 * and cancels the summary request.
 */
export class DashboardPage extends SignalElement {
  #summary = resource(
    (signal) => inject(SALES_SERVICE).dashboard(signal),
    { initial: /** @type {DashboardSummary | null} */ (null), lifetime: () => this.lifetime },
  );

  pending = this.#summary.pending;
  failed = this.#summary.failed;

  /**
   * The panel signal passed to `<x-outlet>` with `&`.
   *
   * @type {import('@core/foundation/types.js').Signal<OutletTarget | null>}
   */
  panel = signal(/** @type {OutletTarget | null} */ (null));

  /**
   * `load` resolves each panel's class. The outlet reads its tag from that class.
   *
   * @type {ReadonlyArray<{ id: string, labelKey: string, target: OutletTarget }>}
   */
  panels = [
    {
      id: 'live',
      labelKey: 'dashboard.panel.live',
      target: {
        load: () => import('./panels/live-panel.js').then((m) => m.LivePanel),
        // Pass numeric values as properties.
        props: { limit: 8 },
      },
    },
    {
      id: 'targets',
      labelKey: 'dashboard.panel.targets',
      target: { load: () => import('./panels/targets-panel.js').then((m) => m.TargetsPanel) },
    },
  ];

  get kpis() {
    return this.#summary.value.value?.kpis ?? [];
  }

  get alerts() {
    return this.#summary.value.value?.alerts ?? [];
  }

  get generatedAt() {
    const at = this.#summary.value.value?.generatedAt;
    return at === undefined ? '' : t('dashboard.generatedAt', { time: dt(at, { timeStyle: 'medium' }) });
  }

  /** @param {{ key: string, value: number, delta: number, currency: string }} kpi */
  kpiLabel(kpi) {
    return t(`dashboard.kpi.${kpi.key}`);
  }

  /** @param {{ sku: string, name: string, stock: number, reorderPoint: number }} alert */
  alertText(alert) {
    return t('dashboard.alert.belowReorder', {
      stock: alert.stock,
      reorderPoint: alert.reorderPoint,
    });
  }

  /** @param {OutletTarget} target */
  select(target) {
    this.panel.value = target;
  }

  /**
   * Compare stable target objects by identity.
   *
   * @param {OutletTarget} target
   */
  isSelected(target) {
    return this.panel.value === target;
  }

  onMount() {
    this.panel.value = this.panels[0]?.target ?? null;
    void this.load();
  }

  load() {
    return this.#summary.reload();
  }
}

await defineComponent({
  tag: 'dashboard-page',
  element: DashboardPage,
  module: import.meta.url,
  uses: [AppCard, AppStat, AppNotice, ComponentOutlet],
});
