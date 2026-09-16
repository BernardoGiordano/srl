import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { resource } from '@core/foundation/resource.js';
import { inject } from '@core/foundation/inject.js';
import { routeParams } from '@core/navigation/router.js';
import { dt, num, t } from '@core/localization/i18n.js';

import { AppBadge } from '../../ui/app-badge.js';
import { AppNotice } from '../../ui/app-notice.js';
import { PEOPLE_SERVICE } from '../../services/people-service.js';

/** @import { Contract } from '../../services/people-service.js' */

/**
 * Show an employee's few contracts as a definition list.
 */
export class EmployeeContractsTab extends SignalElement {
  #contracts = resource(
    (signal) =>
      inject(PEOPLE_SERVICE)
        .contracts(routeParams.value.id ?? '', signal)
        .then((result) => result.rows),
    { initial: /** @type {Contract[]} */ ([]), lifetime: () => this.lifetime },
  );

  pending = this.#contracts.pending;
  failed = this.#contracts.failed;

  get contracts() {
    return this.#contracts.value.value;
  }

  onMount() {
    void this.load();
  }

  /**
   * Wait for the route's employee id before fetching contracts.
   */
  load() {
    return (routeParams.value.id ?? '') === '' ? undefined : this.#contracts.reload();
  }

  /** @param {Contract} contract */
  kindLabel(contract) {
    return t(`people.contractKind.${contract.kind}`);
  }

  /** @param {Contract} contract */
  since(contract) {
    return dt(contract.since, { dateStyle: 'long' });
  }

  /** @param {Contract} contract */
  until(contract) {
    return contract.until === '' ? t('people.openEnded') : dt(contract.until, { dateStyle: 'long' });
  }

  /** @param {Contract} contract */
  hours(contract) {
    return t('people.hoursPerWeek', { hours: num(contract.hours) });
  }

  /** @param {Contract} contract */
  tone(contract) {
    return contract.until === '' ? 'good' : 'info';
  }
}

await defineComponent({
  tag: 'employee-contracts-tab',
  element: EmployeeContractsTab,
  module: import.meta.url,
  uses: [AppBadge, AppNotice],
});
