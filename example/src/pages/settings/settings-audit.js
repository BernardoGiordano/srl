import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { resource } from '@core/foundation/resource.js';
import { inject } from '@core/foundation/inject.js';
import { dt, t } from '@core/localization/i18n.js';

import { AppBadge } from '../../ui/app-badge.js';
import { ago } from '../../format.js';
import { AppNotice } from '../../ui/app-notice.js';
import { ADMIN_SERVICE } from '../../services/admin-service.js';

/** @import { AuditEntry } from '../../services/admin-service.js' */

/**
 * Show server-side writes to users with `audit:read`. The server sends action keys,
 * which this screen translates for the active language.
 */
export class SettingsAudit extends SignalElement {
  #audit = resource(
    (signal) => inject(ADMIN_SERVICE).audit(60, signal).then((result) => result.rows),
    { initial: /** @type {AuditEntry[]} */ ([]), lifetime: () => this.lifetime },
  );

  loading = this.#audit.pending;
  failed = this.#audit.failed;

  get entries() {
    return this.#audit.value.value;
  }

  onMount() {
    void this.load();
  }

  load() {
    return this.#audit.reload();
  }

  /**
   * Fall back to the raw action when its translation is missing.
   *
   * @param {AuditEntry} entry
   */
  actionLabel(entry) {
    const key = `audit.action.${entry.action}`;
    const label = t(key);
    return label === key ? entry.action : label;
  }

  /** @param {AuditEntry} entry */
  when(entry) {
    return dt(entry.at, { dateStyle: 'medium', timeStyle: 'short' });
  }

  /** @param {AuditEntry} entry */
  since(entry) {
    return ago(entry.at);
  }

  /** @param {AuditEntry} entry */
  tone(entry) {
    if (entry.action.endsWith('.suspend')) return 'bad';
    if (entry.action.startsWith('session.')) return 'neutral';
    return 'info';
  }
}

await defineComponent({
  tag: 'settings-audit',
  element: SettingsAudit,
  module: import.meta.url,
  uses: [AppBadge, AppNotice],
});
