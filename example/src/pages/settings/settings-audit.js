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
 * The audit trail: who changed what.
 *
 * Every mutating endpoint on the server appends to it, so advancing an order's status on
 * the sales screen or suspending an account next door shows up here — which is what makes
 * the write paths in this example verifiable rather than merely present. Reading it needs
 * `audit:read`, which only the administrator role carries.
 *
 * The action is a key, not a sentence: the server sends `order.status` and this screen
 * resolves `audit.action.order.status`. A server that sent "changed order status" would
 * have sent it in one language.
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
   * A key the message table may not have: the server can add an action tomorrow. `t()`
   * renders a missing key as the key itself, which is visible on the page and counted by
   * `npm run verify` — so the fallback here is the raw action, which is at least accurate.
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
