import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { resource } from '@core/foundation/resource.js';
import { inject } from '@core/foundation/inject.js';
import { routeParams } from '@core/navigation/router.js';
import { dt, num } from '@core/localization/i18n.js';

import { AppNotice } from '../../ui/app-notice.js';
import { PEOPLE_SERVICE } from '../../services/people-service.js';

/** @import { EmployeeDocument } from '../../services/people-service.js' */

/**
 * Show document metadata for an employee. This example has no downloadable files.
 * `num()` formats sizes for the active locale.
 */
export class EmployeeDocumentsTab extends SignalElement {
  #documents = resource(
    (signal) =>
      inject(PEOPLE_SERVICE)
        .documents(routeParams.value.id ?? '', signal)
        .then((result) => result.rows),
    { initial: /** @type {EmployeeDocument[]} */ ([]), lifetime: () => this.lifetime },
  );

  pending = this.#documents.pending;
  failed = this.#documents.failed;

  get documents() {
    return this.#documents.value.value;
  }

  onMount() {
    void this.load();
  }

  /**
   * Wait for the route's employee id before fetching documents.
   */
  load() {
    return (routeParams.value.id ?? '') === '' ? undefined : this.#documents.reload();
  }

  /** @param {EmployeeDocument} document */
  size(document) {
    return num(document.size / 1_000_000, { style: 'unit', unit: 'megabyte', maximumFractionDigits: 1 });
  }

  /** @param {EmployeeDocument} document */
  when(document) {
    return dt(document.at, { dateStyle: 'medium' });
  }

  /** @param {EmployeeDocument} document */
  kind(document) {
    return document.kind.toUpperCase();
  }
}

await defineComponent({
  tag: 'employee-documents-tab',
  element: EmployeeDocumentsTab,
  module: import.meta.url,
  uses: [AppNotice],
});
