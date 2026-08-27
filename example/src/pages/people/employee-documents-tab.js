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
 * Documents attached to one employee.
 *
 * Nothing downloads: there are no files behind these records, and a link that 404s is
 * worse than a row that says what it is. `num()` with `unit` formatting turns bytes into
 * "1.4 MB" in the active locale, which is the kind of thing hand-written formatting gets
 * wrong in every language but the one it was written in.
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
   * Mounted before the route parameter exists — a tab rendered by a layout whose own
   * match has not landed — there is nothing to ask for. Not asking leaves `pending`
   * true, which is what the screen should be showing.
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
