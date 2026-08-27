import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { resource } from '@core/foundation/resource.js';
import { inject } from '@core/foundation/inject.js';
import { num, t } from '@core/localization/i18n.js';

import { AppCard } from '../../ui/app-card.js';
import { AppBadge } from '../../ui/app-badge.js';
import { AppNotice } from '../../ui/app-notice.js';
import { INVENTORY_SERVICE } from '../../services/inventory-service.js';

/** @import { Warehouse } from '../../services/inventory-service.js' */

/**
 * Warehouses: six of them, so no table.
 *
 * The screen exists to make the point that not every collection is a grid. Six records
 * with four numbers each read better as cards, `ui-table` would add a pager and a column
 * chooser nobody needs, and the utilisation bar is a `<meter>` — a native element with a
 * native accessible value, which is what the div-with-a-width version throws away.
 */
export class WarehousesPage extends SignalElement {
  #warehouses = resource(
    (signal) => inject(INVENTORY_SERVICE).warehouses(signal).then((result) => result.rows),
    { initial: /** @type {Warehouse[]} */ ([]), lifetime: () => this.lifetime },
  );

  rows = this.#warehouses.value;
  pending = this.#warehouses.pending;
  failed = this.#warehouses.failed;

  onMount() {
    void this.load();
  }

  load() {
    return this.#warehouses.reload();
  }

  /** @param {Warehouse} warehouse */
  utilisation(warehouse) {
    return warehouse.capacity === 0 ? 0 : Math.min(1, warehouse.units / warehouse.capacity);
  }

  /** @param {Warehouse} warehouse */
  utilisationLabel(warehouse) {
    return num(this.utilisation(warehouse), { style: 'percent', maximumFractionDigits: 0 });
  }

  /** @param {Warehouse} warehouse */
  capacityLabel(warehouse) {
    return t('warehouses.capacityLabel', {
      units: num(warehouse.units),
      capacity: num(warehouse.capacity),
    });
  }

  /** @param {Warehouse} warehouse */
  skusLabel(warehouse) {
    return t('warehouses.skus', { count: warehouse.skus });
  }

  /** @param {Warehouse} warehouse */
  alertsLabel(warehouse) {
    return t('warehouses.alerts', { count: warehouse.alerts });
  }

  /** @param {Warehouse} warehouse */
  alertTone(warehouse) {
    return warehouse.alerts === 0 ? 'good' : warehouse.alerts > 8 ? 'bad' : 'warn';
  }
}

await defineComponent({
  tag: 'warehouses-page',
  element: WarehousesPage,
  module: import.meta.url,
  uses: [AppCard, AppBadge, AppNotice],
});
