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
 * Contracts, as a definition list rather than a table.
 *
 * One or two rows per employee, and each row has a shape rather than a set of columns —
 * which is the case a table handles worst. The screen next door uses `ui-table` because it
 * has eighty rows of seven identical fields; this one does not, and choosing per screen is
 * the point.
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
   * Mounted before the route parameter exists — a tab rendered by a layout whose own
   * match has not landed — there is nothing to ask for. Not asking leaves `pending`
   * true, which is what the screen should be showing.
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
