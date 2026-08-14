import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { signal } from '@core/foundation/reactive.js';
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
  rows = signal(/** @type {readonly Contract[]} */ ([]));
  failed = signal(false);
  loaded = signal(false);

  /** @type {AbortController | undefined} */
  #request;

  get pending() {
    return !this.loaded.value && !this.failed.value;
  }

  get contracts() {
    return this.rows.value;
  }

  onMount() {
    void this.load();
  }

  onDestroy() {
    this.#request?.abort();
    this.#request = undefined;
  }

  async load() {
    const id = routeParams.value.id ?? '';
    if (id === '') return;

    this.#request?.abort();
    const request = new AbortController();
    this.#request = request;
    this.failed.value = false;

    try {
      const result = await inject(PEOPLE_SERVICE).contracts(id, request.signal);
      if (request.signal.aborted) return;
      this.rows.value = result.rows;
      this.loaded.value = true;
    } catch {
      if (!request.signal.aborted) this.failed.value = true;
    } finally {
      if (this.#request === request) this.#request = undefined;
    }
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
