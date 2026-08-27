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
 * The index tab of the employee detail screen: the record itself.
 *
 * `rel()` renders the hire date as "3 years ago" beside the absolute date. Both, not one:
 * a relative time is easier to judge and an absolute one is what someone copies into a
 * ticket, and `Intl.RelativeTimeFormat` produces the first in the active locale for free.
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
   * Mounted before the route parameter exists — a tab rendered by a layout whose own
   * match has not landed — there is nothing to ask for. Not asking leaves `pending`
   * true, which is what the screen should be showing.
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
