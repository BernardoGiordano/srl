import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { signal } from '@core/foundation/reactive.js';
import { inject } from '@core/foundation/inject.js';
import { routeParams } from '@core/navigation/router.js';
import { dt, t } from '@core/localization/i18n.js';

import { AppField } from '../../ui/app-field.js';
import { ago } from '../../format.js';
import { AppNotice } from '../../ui/app-notice.js';
import { PEOPLE_SERVICE } from '../../services/people-service.js';

/** @import { Employee } from '../../services/people-service.js' */

/**
 * The index tab of the employee detail screen: the record itself.
 *
 * `rel()` renders the hire date as "3 years ago" beside the absolute date. Both, not one:
 * a relative time is easier to judge and an absolute one is what someone copies into a
 * ticket, and `Intl.RelativeTimeFormat` produces the first in the active locale for free.
 */
export class EmployeeProfileTab extends SignalElement {
  employee = signal(/** @type {Employee | null} */ (null));
  failed = signal(false);

  /** @type {AbortController | undefined} */
  #request;

  get pending() {
    return this.employee.value === null && !this.failed.value;
  }

  get hiredOn() {
    const hiredOn = this.employee.value?.hiredOn;
    return hiredOn === undefined ? '' : dt(hiredOn, { dateStyle: 'long' });
  }

  get tenure() {
    const hiredOn = this.employee.value?.hiredOn;
    return hiredOn === undefined ? '' : ago(hiredOn, 'year');
  }

  get record() {
    return this.employee.value;
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
      const employee = await inject(PEOPLE_SERVICE).employee(id, request.signal);
      if (request.signal.aborted) return;
      this.employee.value = employee;
    } catch {
      if (!request.signal.aborted) this.failed.value = true;
    } finally {
      if (this.#request === request) this.#request = undefined;
    }
  }

  get statusLabel() {
    const status = this.employee.value?.status;
    return status === undefined ? '' : t(`people.statusValue.${status}`);
  }
}

await defineComponent({
  tag: 'employee-profile-tab',
  element: EmployeeProfileTab,
  module: import.meta.url,
  uses: [AppField, AppNotice],
});
