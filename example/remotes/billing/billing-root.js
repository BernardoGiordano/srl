import { computed, signal } from '@core/foundation/reactive.js';
import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { cur, dt, t } from '@core/localization/i18n.js';
import { UiTable } from '@components/data/ui-table.js';
import { UiTableColumn } from '@components/data/ui-table-column.js';

/** @import { HostContext, Unsubscribe } from '@core/remotes/types.js' */

/**
 * The billing remote's root.
 *
 * WHAT IT SHARES, AND WHAT IT ASKS FOR
 *
 * It shares the *stack*: Lit, the signals library, the template compiler, the i18n module
 * and two elements from `source/components`. A remote using the shell's component
 * collection is worth demonstrating — the collection imports nothing from an application,
 * so it works here exactly as it does in `src/`, and this screen's table has the same
 * sorting, column chooser and accessible names as the shell's own.
 *
 * It does not share the shell's *state*. Routing arrives through `mount(host)`, not by
 * importing `currentPath` and `navigate` — which would resolve, and would duplicate the
 * mount path and bypass a capability `revoke()` can take back. ADR-0063.
 *
 * Sub-view routing stays this remote's business. The shell's route table knows nothing of
 * `/invoices` or `/plans`, which is exactly what lets this folder add or rename a sub-view
 * with no shell change, and the prefix those views hang off comes from `host.mount`.
 *
 * The data is local on purpose: this remote is granted no API access in the manifest, and
 * it needs none. `remotes/analytics/` is the one that calls a server, and its grants say
 * exactly which paths it may reach.
 */
export class BillingRoot extends SignalElement {
  /** This mount's capabilities, handed over by `remote-entry.js` before connection. */
  /** @type {HostContext | undefined} */
  #host;

  /**
   * The shell's path, pushed in through the context rather than read from the shell's
   * signal. A signal on this side of the seam is what turns the contract's callback into
   * something a template can render off — and the contract deals in callbacks on purpose,
   * since exposing a `Signal` would oblige every remote to agree on the shell's reactive
   * library.
   */
  #path = signal('');

  /** @type {Unsubscribe | undefined} */
  #unsubscribe;

  /** @type {readonly string[]} */
  views = ['overview', 'invoices', 'plans'];

  view = computed(() => {
    const { mount } = this.#requireHost();
    const path = this.#path.value;

    // The prefix check is not redundant. A computed keeps evaluating while anything reads
    // it, and this element is alive for a moment after the router has navigated away — the
    // shell reports the new path before the mount is torn down — so an unrelated path
    // would otherwise be sliced into a view name that does not exist. Harmless on screen,
    // and it puts a missing-key warning in the console that sends you to the wrong file.
    if (path !== mount && !path.startsWith(`${mount}/`)) return 'overview';

    const rest = path.slice(mount.length).replace(/^\/+/u, '');
    return rest === '' ? 'overview' : (rest.split('/')[0] ?? 'overview');
  });

  /** @type {readonly { id: string, customer: string, issuedOn: string, dueOn: string, amount: number, status: string }[]} */
  invoices = [
    { id: 'IN-2026-0041', customer: 'Aurora Utilities', issuedOn: '2026-06-02', dueOn: '2026-07-02', amount: 18_420.5, status: 'open' },
    { id: 'IN-2026-0042', customer: 'Borealis Logistics', issuedOn: '2026-06-04', dueOn: '2026-07-04', amount: 4_180, status: 'paid' },
    { id: 'IN-2026-0043', customer: 'Meridian Systems', issuedOn: '2026-06-11', dueOn: '2026-07-11', amount: 62_900.9, status: 'open' },
    { id: 'IN-2026-0044', customer: 'Rialto Energia', issuedOn: '2026-06-18', dueOn: '2026-07-18', amount: 9_310.25, status: 'overdue' },
    { id: 'IN-2026-0045', customer: 'Zenit Retail', issuedOn: '2026-06-24', dueOn: '2026-07-24', amount: 2_740, status: 'paid' },
  ];

  get outstanding() {
    return this.invoices
      .filter((invoice) => invoice.status !== 'paid')
      .reduce((sum, invoice) => sum + invoice.amount, 0);
  }

  get outstandingLabel() {
    return t('billing.total', { amount: cur(this.outstanding, 'EUR') });
  }

  get userName() {
    return this.#requireHost().auth.user()?.name ?? '';
  }

  /**
   * Receive this mount's capability context.
   *
   * Called between `createElement` and insertion, so the first render already has a path
   * and a mount prefix. Never stored at module scope: a second visit gets a second
   * context, and the revoked first one is unreachable.
   *
   * @param {HostContext} host
   */
  useHost(host) {
    this.#host = host;
    this.#path.value = host.router.path();
  }

  connectedCallback() {
    super.connectedCallback();
    const host = this.#requireHost();
    // A custom element can be moved in the DOM, which runs this again. Subscribing without
    // dropping the previous one leaves a duplicate per move.
    this.#unsubscribe?.();
    this.#unsubscribe = host.router.onChange(() => {
      this.#path.value = host.router.path();
    });
  }

  onDestroy() {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  /** @param {string} name */
  go(name) {
    const host = this.#requireHost();
    // Through the context, so this remote has one way out and the shell keeps the ability
    // to cut it. Completion is not offered across the seam: a remote awaiting the shell's
    // navigation would learn only that a guard sent the user elsewhere.
    host.router.navigate(name === 'overview' ? host.mount : `${host.mount}/${name}`);
  }

  /** @param {string} name */
  isActive(name) {
    return this.view.value === name;
  }

  /** @param {unknown} row */
  renderAmount = (row) => cur(/** @type {{ amount: number }} */ (row).amount, 'EUR');

  /** @param {unknown} row */
  sortAmount = (row) => /** @type {{ amount: number }} */ (row).amount;

  /** @param {unknown} row */
  renderStatus = (row) => t(`billing.status.${/** @type {{ status: string }} */ (row).status}`);

  /** @param {unknown} row */
  renderIssuedOn = (row) =>
    dt(/** @type {{ issuedOn: string }} */ (row).issuedOn, { dateStyle: 'medium' });

  /** @param {unknown} row */
  renderDueOn = (row) => dt(/** @type {{ dueOn: string }} */ (row).dueOn, { dateStyle: 'medium' });

  /** @param {unknown} row */
  rowKey = (row) => /** @type {{ id: string }} */ (row).id;

  /** @returns {HostContext} */
  #requireHost() {
    if (this.#host === undefined) {
      throw new Error(
        `<billing-root> has no host context. It is a micro-frontend root: the shell creates it ` +
          `through mount(host) in remote-entry.js, which hands it one. Placing the tag in markup ` +
          `by hand skips that, and there is no mount path or router for it to render against.`,
      );
    }
    return this.#host;
  }
}

await defineComponent({
  tag: 'billing-root',
  element: BillingRoot,
  module: import.meta.url,
  uses: [UiTable, UiTableColumn],
});
