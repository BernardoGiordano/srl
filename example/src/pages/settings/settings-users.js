import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { signal } from '@core/foundation/reactive.js';
import { resource } from '@core/foundation/resource.js';
import { inject } from '@core/foundation/inject.js';
import { dt, t } from '@core/localization/i18n.js';
import { AUTH_SESSION } from '@auth/session.js';
import { UiTable } from '@components/data/ui-table.js';
import { UiTableColumn } from '@components/data/ui-table-column.js';

import { AppBadge } from '../../ui/app-badge.js';
import { ago } from '../../format.js';
import { AppNotice } from '../../ui/app-notice.js';
import { ADMIN_SERVICE } from '../../services/admin-service.js';
import { ApiError } from '@core/http/client.js';

/** @import { AccountUser } from '../../services/admin-service.js' */

/**
 * The refusal `rowSelectable` hands the table when nothing may be chosen. Hoisted so
 * its identity is stable: a new function per render would invalidate the table's page
 * selection cache on every paint.
 */
const refuseRow = () => false;

/**
 * Account administration: the screen with a write path.
 *
 * `users:read` guards the route; `users:write` gates the buttons. Two scopes rather than
 * one, because "can see who has an account" and "can suspend an account" are different
 * questions and an operator answers yes to the first and no to the second.
 *
 * THE PART WORTH COPYING
 *
 * The action button is rendered for everyone and disabled with a reason for those who may
 * not use it. Hiding it would be easier and worse: a control that vanishes for reasons the
 * user cannot see is indistinguishable from a broken page, and the support conversation
 * that follows is "it works for me". The server enforces the scope regardless — a 403
 * comes back with `insufficient_scope` and lands in the notice above the table.
 *
 * The list is re-read after a write rather than patched locally. Optimistic updates are a
 * legitimate choice, but they need a rollback path, and this screen's write is one field on
 * one row: two round trips are cheaper than the machinery, and the rows belong to the
 * resource — a screen that reached in to edit them would own a second copy of the list.
 *
 * The bulk bar is what `ui-table`'s selection is for. The table owns which rows are chosen
 * and keeps them keyed through sorting and paging; this screen owns what choosing them
 * means, which is one PATCH per account and a re-read. The keys are the whole selection —
 * the table never claims to have chosen records it was never given.
 */
export class SettingsUsers extends SignalElement {
  #users = resource(
    (signal) => inject(ADMIN_SERVICE).users(signal).then((result) => result.rows),
    { initial: /** @type {AccountUser[]} */ ([]), lifetime: () => this.lifetime },
  );

  rows = this.#users.value;
  loading = this.#users.pending;
  failed = this.#users.failed;
  /** Id of the row currently being written, or the empty string. */
  saving = signal('');
  /** True while the bulk bar's write is in flight. */
  bulkSaving = signal(false);
  errorKey = signal('');

  /** The accounts the table has chosen, owned here so the bulk bar can read them. */
  selectedKeys = signal(/** @type {readonly unknown[]} */ ([]));

  get canWrite() {
    return inject(AUTH_SESSION).scopes.value.includes('users:write');
  }

  /** One write at a time, whether it came from a row button or the bulk bar. */
  get busy() {
    return this.saving.value !== '' || this.bulkSaving.value;
  }

  get selectionCount() {
    return this.selectedKeys.value.length;
  }

  /**
   * Whether a row may be chosen at all.
   *
   * A getter rather than a stable field, because the answer changes with the session
   * and with a write in flight, and the table only re-reads a property whose identity
   * moved. `undefined` means every row is available; `refuseRow` means none is.
   */
  get rowSelectable() {
    return this.canWrite && !this.busy ? undefined : refuseRow;
  }

  get errorMessage() {
    return this.errorKey.value === '' ? '' : t(this.errorKey.value);
  }

  onMount() {
    void this.load();
  }

  load() {
    return this.#users.reload();
  }

  /** @param {Event} event */
  captureSelection(event) {
    this.selectedKeys.value = /** @type {CustomEvent<{ keys: readonly unknown[] }>} */ (
      event
    ).detail.keys;
  }

  clearSelection() {
    this.selectedKeys.value = [];
  }

  /** @param {'active' | 'suspended'} status */
  applyToSelection(status) {
    void this.#writeSelection(status);
  }

  /**
   * The bulk write: one PATCH per account, in order, then one re-read.
   *
   * Sequential rather than parallel because the audit trail should read in the order
   * the operator chose, and because a server that rate-limits a burst would turn a
   * bulk action into a partial one for reasons the screen cannot explain. A failure
   * leaves the selection standing, so retrying is one click rather than a re-selection.
   *
   * @param {'active' | 'suspended'} status
   */
  async #writeSelection(status) {
    const ids = this.selectedKeys.value.map(String);
    if (!this.canWrite || this.busy || ids.length === 0) return;

    this.bulkSaving.value = true;
    this.errorKey.value = '';
    const service = inject(ADMIN_SERVICE);

    try {
      for (const id of ids) await service.setUserStatus(id, status);
      this.selectedKeys.value = [];
    } catch (cause) {
      this.errorKey.value =
        cause instanceof ApiError && cause.forbidden ? 'settings.writeForbidden' : 'common.saveFailed';
    } finally {
      this.bulkSaving.value = false;
      await this.#users.reload();
    }
  }

  /** @param {AccountUser} user */
  toggle(user) {
    if (!this.canWrite || this.busy) return;
    const next = user.status === 'active' ? 'suspended' : 'active';

    this.saving.value = user.id;
    this.errorKey.value = '';

    void inject(ADMIN_SERVICE)
      .setUserStatus(user.id, next)
      .then(() => this.#users.reload())
      .catch((cause) => {
        this.errorKey.value =
          cause instanceof ApiError && cause.forbidden ? 'settings.writeForbidden' : 'common.saveFailed';
      })
      .finally(() => {
        this.saving.value = '';
      });
  }

  /* ── Cells ──────────────────────────────────────────────────────────────── */

  /**
   * A renderer may return any node, including one of this application's own components:
   * `AppBadge` is imported above, so its module has evaluated and the tag is defined by
   * the time this runs. That import is the dependency — `uses` is the same statement for
   * elements the *template* names, and this one is named by JavaScript.
   *
   * @param {unknown} row
   */
  renderStatus = (row) => {
    const user = /** @type {AccountUser} */ (row);
    const badge = document.createElement('app-badge');
    badge.setAttribute('tone', user.status === 'active' ? 'good' : 'bad');
    badge.textContent = t(`settings.userStatus.${user.status}`);
    return badge;
  };

  /** @param {unknown} row */
  filterStatus = (row) => t(`settings.userStatus.${/** @type {AccountUser} */ (row).status}`);

  /** @param {unknown} row */
  renderRole = (row) => t(`role.${/** @type {AccountUser} */ (row).role}`);

  /** @param {unknown} row */
  renderLastSeen = (row) => {
    const user = /** @type {AccountUser} */ (row);
    const wrapper = document.createElement('span');
    wrapper.title = dt(user.lastSeen, { dateStyle: 'medium', timeStyle: 'short' });
    wrapper.textContent = ago(user.lastSeen);
    return wrapper;
  };

  /**
   * The action cell. Built imperatively because it is a control rather than text, and
   * because its disabled state and its title depend on the row and the session together.
   *
   * @param {unknown} row
   */
  renderAction = (row) => {
    const user = /** @type {AccountUser} */ (row);
    const button = document.createElement('button');
    button.type = 'button';
    button.className =
      'cursor-pointer rounded-md border border-ui-border px-2.5 py-1 text-[12px] font-semibold transition-colors hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50';
    button.textContent = t(user.status === 'active' ? 'settings.suspend' : 'settings.activate');
    button.disabled = !this.canWrite || this.busy;
    if (!this.canWrite) button.title = t('settings.needsWriteScope');
    button.addEventListener('click', () => this.toggle(user));
    return button;
  };

  /** @param {unknown} row */
  rowKey = (row) => /** @type {AccountUser} */ (row).id;
}

await defineComponent({
  tag: 'settings-users',
  element: SettingsUsers,
  module: import.meta.url,
  uses: [AppBadge, AppNotice, UiTable, UiTableColumn],
});
