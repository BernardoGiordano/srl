import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { computed, effect, signal } from '@core/foundation/reactive.js';
import { inject } from '@core/foundation/inject.js';
import { RouteOutlet, routeParams } from '@core/navigation/router.js';
import { t } from '@core/localization/i18n.js';
import { UiAvatar } from '@components/shell/ui-avatar.js';

import { AppBadge } from '../../ui/app-badge.js';
import { AppNotice } from '../../ui/app-notice.js';
import { AppTabs } from '../../ui/app-tabs.js';
import { PEOPLE_SERVICE } from '../../services/people-service.js';

/** @import { Employee } from '../../services/people-service.js' */
/** @import { TabItem } from '../../ui/app-tabs.js' */

/**
 * One employee: the second layout route, and deliberately the same shape as the order
 * detail screen.
 *
 * The repetition is the point of having both. Two detail screens written the same way
 * means the pattern — layout fetches the header, an effect over `routeParams` drives the
 * reload, children fetch their own slices — is a pattern rather than a one-off, and the
 * next one is a copy rather than a decision.
 */
export class EmployeeDetailPage extends SignalElement {
  employee = signal(/** @type {Employee | null} */ (null));
  failed = signal(false);

  /** @type {AbortController | undefined} */
  #request;

  /** @type {(() => void) | undefined} */
  #stopWatching;

  get employeeId() {
    return routeParams.value.id ?? '';
  }

  get pending() {
    return this.employee.value === null && !this.failed.value;
  }

  get name() {
    return this.employee.value?.name ?? this.employeeId;
  }

  get role() {
    return this.employee.value?.role ?? '';
  }

  get team() {
    return this.employee.value?.team ?? '';
  }

  get email() {
    return this.employee.value?.email ?? '';
  }

  get status() {
    return this.employee.value?.status ?? '';
  }

  get statusLabel() {
    return this.status === '' ? '' : t(`people.statusValue.${this.status}`);
  }

  get statusTone() {
    return this.status === 'active' ? 'good' : 'warn';
  }

  /** @type {import('@core/foundation/types.js').ReadonlySignal<readonly TabItem[]>} */
  #tabs = computed(() => {
    const base = `/people/employees/${this.employeeId}`;
    return [
      { key: 'profile', label: t('people.tabProfile'), href: base, exact: true },
      { key: 'contracts', label: t('people.tabContracts'), href: `${base}/contracts` },
      { key: 'documents', label: t('people.tabDocuments'), href: `${base}/documents` },
    ];
  });

  get tabs() {
    return this.#tabs.value;
  }

  onMount() {
    let previous = '';
    this.#stopWatching = effect(() => {
      const id = this.employeeId;
      if (id === '' || id === previous) return;
      previous = id;
      void this.load(id);
    });
  }

  onDestroy() {
    this.#stopWatching?.();
    this.#stopWatching = undefined;
    this.#request?.abort();
    this.#request = undefined;
  }

  retry() {
    if (this.employeeId !== '') void this.load(this.employeeId);
  }

  /** @param {string} id */
  async load(id) {
    this.#request?.abort();
    const request = new AbortController();
    this.#request = request;
    this.failed.value = false;

    try {
      const employee = await inject(PEOPLE_SERVICE).employee(id, request.signal);
      if (request.signal.aborted) return;
      this.employee.value = employee;
    } catch {
      if (!request.signal.aborted) {
        this.employee.value = null;
        this.failed.value = true;
      }
    } finally {
      if (this.#request === request) this.#request = undefined;
    }
  }
}

await defineComponent({
  tag: 'employee-detail-page',
  element: EmployeeDetailPage,
  module: import.meta.url,
  uses: [AppBadge, AppNotice, AppTabs, UiAvatar, RouteOutlet],
});
