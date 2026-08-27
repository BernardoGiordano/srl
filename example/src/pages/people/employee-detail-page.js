import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { computed, effect } from '@core/foundation/reactive.js';
import { resource } from '@core/foundation/resource.js';
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
  #employee = resource(
    (signal) => inject(PEOPLE_SERVICE).employee(routeParams.value.id ?? '', signal),
    { initial: /** @type {Employee | null} */ (null), lifetime: () => this.lifetime },
  );

  pending = this.#employee.pending;
  failed = this.#employee.failed;

  /** @type {(() => void) | undefined} */
  #stopWatching;

  get employeeId() {
    return routeParams.value.id ?? '';
  }

  /**
   * The record, or nothing while the last load is failing. A resource keeps the value
   * it had, which is right for a list that is being refreshed and wrong for a header:
   * the previous employee's name under a "not found" notice is a worse answer than no
   * name at all.
   */
  get record() {
    return this.failed.value ? null : this.#employee.value.value;
  }

  get name() {
    return this.record?.name ?? this.employeeId;
  }

  get role() {
    return this.record?.role ?? '';
  }

  get team() {
    return this.record?.team ?? '';
  }

  get email() {
    return this.record?.email ?? '';
  }

  get status() {
    return this.record?.status ?? '';
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
      void this.load();
    });
  }

  onDestroy() {
    this.#stopWatching?.();
    this.#stopWatching = undefined;
  }

  retry() {
    return this.load();
  }

  load() {
    return this.employeeId === '' ? undefined : this.#employee.reload();
  }
}

await defineComponent({
  tag: 'employee-detail-page',
  element: EmployeeDetailPage,
  module: import.meta.url,
  uses: [AppBadge, AppNotice, AppTabs, UiAvatar, RouteOutlet],
});
