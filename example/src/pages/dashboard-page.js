import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { ComponentOutlet } from '@core/elements/outlet.js';
import { signal } from '@core/foundation/reactive.js';
import { inject } from '@core/foundation/inject.js';
import { dt, t } from '@core/localization/i18n.js';

import { AppCard } from '../ui/app-card.js';
import { AppStat } from '../ui/app-stat.js';
import { AppNotice } from '../ui/app-notice.js';
import { SALES_SERVICE } from '../services/sales-service.js';

/** @import { DashboardSummary } from '../services/sales-service.js' */
/** @import { OutletTarget } from '@core/elements/types.js' */

/**
 * The landing screen: four KPI tiles, a panel the user chooses, and the alert list.
 *
 * Three things are worth reading for:
 *
 *  - **the tiles receive numbers, not strings.** The server sends `{ value, currency,
 *    delta }` and `app-stat` formats through `Intl`, so switching to Italian re-renders
 *    `1.234,50 €` from the same payload. An API that formatted server-side would have
 *    to be told the locale, and would be wrong the moment the user changed it.
 *  - **the panel is hot-swapped by a signal.** `[.target]="&panel"` hands the outlet the
 *    signal itself, so choosing a panel mounts a module that was never fetched before
 *    and re-renders nothing in this component.
 *  - **one request, one abort.** `onDestroy` aborts, so navigating away during a slow
 *    request does not write into an element that has left the document.
 */
export class DashboardPage extends SignalElement {
  summary = signal(/** @type {DashboardSummary | null} */ (null));
  failed = signal(false);

  /**
   * Which panel `<x-outlet>` shows. Public because the template passes the signal
   * itself with `&`, which is what lets the outlet subscribe directly.
   *
   * @type {import('@core/foundation/types.js').Signal<OutletTarget | null>}
   */
  panel = signal(/** @type {OutletTarget | null} */ (null));

  /**
   * No tag appears here: `load` resolves the panel's class and the outlet reads the
   * tag from that component's own definition, so each tag exists once, in its own
   * module.
   *
   * @type {ReadonlyArray<{ id: string, labelKey: string, target: OutletTarget }>}
   */
  panels = [
    {
      id: 'live',
      labelKey: 'dashboard.panel.live',
      target: {
        load: () => import('./panels/live-panel.js').then((m) => m.LivePanel),
        // Assigned as properties, never attributes, so a number stays a number and
        // an object would survive the crossing.
        props: { limit: 8 },
      },
    },
    {
      id: 'targets',
      labelKey: 'dashboard.panel.targets',
      target: { load: () => import('./panels/targets-panel.js').then((m) => m.TargetsPanel) },
    },
  ];

  /** @type {AbortController | undefined} */
  #request;

  get kpis() {
    return this.summary.value?.kpis ?? [];
  }

  get alerts() {
    return this.summary.value?.alerts ?? [];
  }

  get pending() {
    return this.summary.value === null && !this.failed.value;
  }

  get generatedAt() {
    const at = this.summary.value?.generatedAt;
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
   * Identity, not tag equality: the targets in `panels` are stable objects and
   * `select` assigns one of them, so comparing them is exact — and a target does not
   * carry a tag to compare in the first place.
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
      this.summary.value = summary;
    } catch (cause) {
      if (!request.signal.aborted) this.failed.value = true;
      if (!(cause instanceof Error)) throw cause;
    } finally {
      if (this.#request === request) this.#request = undefined;
    }
  }
}

await defineComponent({
  tag: 'dashboard-page',
  element: DashboardPage,
  module: import.meta.url,
  uses: [AppCard, AppStat, AppNotice, ComponentOutlet],
});
