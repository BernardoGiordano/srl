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
 * Keep the refusal callback stable across renders.
 */
const refuseRow = () => false;

/**
 * Show accounts to readers and enable writes for users with `users:write`. The
 * table keeps selection by row key. This screen sends the writes and reloads the
 * list, while the server checks the write scope.
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
   * Update row selection when scope or write state changes.
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
   * Write selected accounts in order, then reload the list. Keep the selection
   * after a failure so the user can retry.
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
   * Render `AppBadge` after its module has defined the element.
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
   * Build the action control from the row and session state.
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
