import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { resource } from '@core/foundation/resource.js';
import { inject } from '@core/foundation/inject.js';
import { routeParams } from '@core/navigation/router.js';
import { dt, t } from '@core/localization/i18n.js';

import { AppField } from '../../ui/app-field.js';
import { ago } from '../../format.js';
import { AppNotice } from '../../ui/app-notice.js';
import { PEOPLE_SERVICE } from '../../services/people-service.js';

/** @import { Employee } from '../../services/people-service.js' */

/**
 * Show the employee record. The hire date appears in absolute and relative form,
 * with `rel()` using the active locale.
 */
export class EmployeeProfileTab extends SignalElement {
  #employee = resource(
    (signal) => inject(PEOPLE_SERVICE).employee(routeParams.value.id ?? '', signal),
    { initial: /** @type {Employee | null} */ (null), lifetime: () => this.lifetime },
  );

  pending = this.#employee.pending;
  failed = this.#employee.failed;

  get hiredOn() {
    const hiredOn = this.record?.hiredOn;
    return hiredOn === undefined ? '' : dt(hiredOn, { dateStyle: 'long' });
  }

  get tenure() {
    const hiredOn = this.record?.hiredOn;
    return hiredOn === undefined ? '' : ago(hiredOn, 'year');
  }

  get record() {
    return this.#employee.value.value;
  }

  onMount() {
    void this.load();
  }

  /**
   * Wait for the route's employee id before fetching the profile.
   */
  load() {
    return (routeParams.value.id ?? '') === '' ? undefined : this.#employee.reload();
  }

  get statusLabel() {
    const status = this.record?.status;
    return status === undefined ? '' : t(`people.statusValue.${status}`);
  }
}

await defineComponent({
  tag: 'employee-profile-tab',
  element: EmployeeProfileTab,
  module: import.meta.url,
  uses: [AppField, AppNotice],
});
