import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { computed, effect, signal } from '@core/foundation/reactive.js';
import { resource } from '@core/foundation/resource.js';
import { inject } from '@core/foundation/inject.js';
import { navigate, queryParams, routeParams } from '@core/navigation/router.js';
import { t } from '@core/localization/i18n.js';
import { AUTH_SESSION } from '@auth/session.js';
import { fieldArray } from '@core/forms/array.js';
import { field } from '@core/forms/field.js';
import { group } from '@core/forms/group.js';
import { email, maxLength, minLength, notAfter, oneOf, required } from '@core/forms/validators.js';
import { UiCombobox } from '@components/inputs/ui-combobox.js';
import { UiField, focusInvalidField } from '@components/inputs/ui-field.js';
import { UiDialog } from '@components/overlays/ui-dialog.js';

import { AppCard } from '../../ui/app-card.js';
import { AppNotice } from '../../ui/app-notice.js';
import { SALES_SERVICE } from '../../services/sales-service.js';
import { LOOKUP_SERVICE } from '../../services/lookup-service.js';
import { ApiError } from '@core/http/client.js';

/** @import { Customer, CustomerContact, CustomerInput } from '../../services/sales-service.js' */
/** @import { ComboboxOption } from '@components/inputs/ui-combobox.js' */

const SEGMENTS = ['enterprise', 'midmarket', 'smb', 'public'];
const CONTACT_ROLES = ['billing', 'technical', 'commercial'];
const NOTES_MAX = 280;

/** What the server accepts. Repeated here so the Add control stops before a 422. */
const CONTACTS_MAX = 5;

/**
 * One customer: read it, edit it, or create it. Three modes, one screen.
 *
 * WHAT THIS FILE IS FOR
 *
 * It was written twice: once with nothing but native inputs and the template
 * dialect, to measure what a form costs without a forms layer, and again on
 * `@core/forms` and `<ui-field>`. What is left below
 * is the part that is actually about customers — which rules apply, what the server
 * is asked, where to go afterwards.
 *
 * THE MODE IS IN THE URL
 *
 * `/sales/customers/:id` reads, `?edit=true` edits, `/sales/customers/new`
 * creates. Nothing here holds an `editing` flag. That is also why the
 * discard prompt is not asked on the way in or out of edit mode — the guard is
 * about leaving the screen, and a query change does not leave it. Only `cancel()`
 * discards, and it says so on the button.
 *
 * THE RULES ARE THE DECLARATION
 *
 * `group()` is the whole of the form's state. Validity, touched, dirty, the
 * timing rule for showing an error, and the server's per-field answers are all
 * derived from it, and none of them appears as a signal in this class. Two of
 * the server's rules — a name and an email address are unique across the account
 * — have no counterpart here on purpose: no client holds the data to answer
 * them, so they arrive as a 422 and `applyErrors` puts each one under its field.
 *
 * WHAT IS STILL THIS SCREEN'S JOB
 *
 * Loading, saving, and translating between the form's strings and the API's
 * types. Values stay strings until `toInput`, because `Number('')` is `0` and a
 * form that converts per keystroke cannot tell an empty revenue field from a
 * customer who has spent nothing.
 *
 * LEAVING WITH UNSAVED WORK
 *
 * `canLeave()` is the route's `canDeactivate` (see `routes.js`). It resolves
 * against a `<ui-dialog>` rather than `confirm()`: the native prompt blocks the
 * event loop, cannot be styled or translated, and reads as a browser error to
 * the user. The dialog is `mandatory`, because the guard is holding a promise
 * that only an answer can resolve. `beforeunload` still covers closing the tab,
 * which is the one navigation no application can intercept.
 */
export class CustomerDetailPage extends SignalElement {
  form = group({
    name: field('', [required(), minLength(2), maxLength(80)]),
    email: field('', [required(), email()]),
    segment: field('', [required(), oneOf(SEGMENTS)]),
    country: field('', [required()]),
    city: field('', [required(), maxLength(60)]),
    owner: field('', [required(), maxLength(80)]),
    since: field('', [required(), notAfter()]),
    revenue: field('', [nonNegativeAmount]),
    notes: field('', [maxLength(NOTES_MAX)]),
    /*
     * The repeating row, and the reason `@core/forms` grew arrays at all.
     * ADR-0009. What the screen writes is the shape of one contact; the array
     * owns how many there are, what each is called in a 422, whether adding one
     * counts as an unsaved change, and putting the deleted ones back on cancel.
     */
    contacts: fieldArray(() =>
      group({
        name: field('', [required(), maxLength(80)]),
        email: field('', [required(), email()]),
        role: field('', [required(), oneOf(CONTACT_ROLES)]),
      }),
    ),
  });

  #customer = resource(
    (signal) => inject(SALES_SERVICE).customer(routeParams.value.id ?? '', signal),
    { initial: /** @type {Customer | null} */ (null), lifetime: () => this.lifetime },
  );

  /**
   * `/sales/customers/new` has nothing to read, so the resource is never asked and its
   * own `pending` stays true — which is the right answer for a screen waiting on a
   * record and the wrong one for a screen creating one. The mode is what tells them
   * apart, and this is the only place that has to know.
   */
  loading = computed(() => this.customerId !== '' && this.#customer.pending.value);

  failed = this.#customer.failed;
  saving = signal(false);

  /** The name the customer was loaded under. What view mode is a heading for. */
  loadedName = signal('');

  /** Message key of a failure that belongs to no single field. */
  saveErrorKey = signal('');

  /** @type {import('@core/foundation/types.js').Signal<readonly ComboboxOption[]>} */
  countryOptions = signal(/** @type {readonly ComboboxOption[]} */ ([]));

  /** Resolves once the user answers the discard prompt. Absent when it is closed. */
  #pendingLeave = signal(/** @type {((allowed: boolean) => void) | null} */ (null));

  /** @type {(() => void) | undefined} */
  #stopWatching;

  /** @type {(() => void) | undefined} */
  #stopMode;

  /** @type {((event: BeforeUnloadEvent) => void) | undefined} */
  #beforeUnload;

  /* ── Identity and mode ──────────────────────────────────────────────────── */

  get customerId() {
    return routeParams.value.id ?? '';
  }

  /**
   * Editable, and the one derivation the rest of the screen hangs off.
   *
   * Creating has nothing to read, so the mode is not a question; editing is,
   * and the query alone does not answer it — a URL is typed by anyone, and a
   * form that enabled itself for a reader would let them fill in a save the
   * server is going to refuse.
   *
   * `sales:write` is checked in both branches even though `customers/new` is a
   * guarded route, because a guard runs once at navigation and this is a signal.
   * A session that loses the scope while the screen is mounted — a second tab
   * signing in as a reader against the same cookie, a refresh that comes back
   * with fewer entitlements — leaves a live form behind an entitlement that is
   * gone, and the first thing the user learns is a 403 on a filled-in record.
   *
   * @type {import('@core/foundation/types.js').ReadonlySignal<boolean>}
   */
  #editing = computed(() => {
    const writable = inject(AUTH_SESSION).scopes.value.includes('sales:write');
    if ((routeParams.value.id ?? '') === '') return writable;
    if (queryParams.value.get('edit') !== 'true') return false;
    return writable;
  });

  get creating() {
    return this.customerId === '';
  }

  get editing() {
    return this.#editing.value;
  }

  get viewing() {
    return !this.#editing.value;
  }

  get canWrite() {
    return inject(AUTH_SESSION).scopes.value.includes('sales:write');
  }

  /** Why the edit control is disabled, as a title. Empty when it is not. */
  get writeHint() {
    return this.canWrite ? '' : t('customers.needsWriteScope');
  }

  /**
   * The heading. Creating has no customer to name, and editing is a mode of the
   * same screen rather than a different place, so the name stands in both — the
   * word "Edit" belongs on the control that got the user here, not on the record.
   */
  get title() {
    if (this.creating) return t('customerForm.newTitle');
    return this.loadedName.value === '' ? this.customerId : this.loadedName.value;
  }

  /** The instruction only applies where there is something to fill in. */
  get lead() {
    return this.editing ? t('customerForm.lead') : '';
  }

  /* ── Template surface ───────────────────────────────────────────────────── */

  get fields() {
    return this.form.fields;
  }

  get dirty() {
    return this.form.dirty.value;
  }

  get saveDisabled() {
    return this.saving.value || this.loading.value || (this.form.submitted.value && !this.form.valid.value);
  }

  get saveError() {
    return this.saveErrorKey.value === '' ? '' : t(this.saveErrorKey.value);
  }

  get saveLabel() {
    return this.saving.value ? t('common.saving') : t('customerForm.save');
  }

  get askingToLeave() {
    return this.#pendingLeave.value !== null;
  }

  get notesCount() {
    return t('customerForm.notesCount', { count: this.fields.notes.value.value.length, max: NOTES_MAX });
  }

  /* ── Contacts ───────────────────────────────────────────────────────────── */

  /**
   * The rows, each with the key a keyed `*for` tracks and the index its fields
   * are addressed by. Nothing here holds them: the array does, and it is part of
   * the form, so a contact added and then abandoned is caught by the same dirty
   * check and the same discard prompt as a typo in the name.
   */
  get contactRows() {
    return this.fields.contacts.rows.value;
  }

  get hasContacts() {
    return this.fields.contacts.length.value > 0;
  }

  /**
   * Nothing to add when the form is not editable or the server would refuse it.
   * The limit is the server's; this is the affordance, and `api.mjs` still
   * answers `contacts: tooMany` to anything that gets past it.
   */
  get canAddContact() {
    return this.editing && this.fields.contacts.length.value < CONTACTS_MAX;
  }

  /** Why the Add control is off. The template renders it only when it is. */
  get contactsLimitHint() {
    return t('customerForm.contactsLimit', { max: CONTACTS_MAX });
  }

  addContact() {
    if (!this.canAddContact) return;
    this.fields.contacts.push();
  }

  /** @param {number} index */
  removeContact(index) {
    if (!this.editing) return;
    this.fields.contacts.removeAt(index);
  }

  /**
   * @type {import('@core/foundation/types.js').ReadonlySignal<readonly ComboboxOption[]>}
   */
  #contactRoleOptions = computed(() =>
    CONTACT_ROLES.map((value) => ({ value, label: t(`customers.contactRole.${value}`) })),
  );

  get contactRoleOptions() {
    return this.#contactRoleOptions.value;
  }

  /*
   * The control styling, written once instead of nine times. It was already
   * repeated in the first version of this screen; `ui-field` removed the reason
   * the repetition was hard to see, which is the sort of thing an extraction
   * turns up on its way past.
   */

  get inputClass() {
    return 'mt-1 w-full rounded-md border border-ui-border bg-surface-raised px-3 py-2 text-[13.5px] text-ink outline-none focus:border-accent focus:outline-2 focus:outline-offset-1 focus:outline-accent aria-[invalid=true]:border-rose-500 disabled:cursor-not-allowed disabled:opacity-60';
  }

  get comboboxControlClass() {
    return 'flex min-h-[38px] w-full flex-wrap items-center gap-1.5 rounded-md border border-ui-border bg-surface-raised px-2 py-1.5 text-[13px] data-[invalid=true]:border-rose-500';
  }

  get comboboxPanelClass() {
    return 'z-50 max-h-72 w-[min(22rem,90vw)] overflow-y-auto rounded-lg border border-ui-border bg-surface-raised py-1 text-[13px] shadow-[0_12px_32px_var(--ui-color-shadow)]';
  }

  /**
   * The codes this application's server can send that the collection does not
   * know. Passed to the fields that can receive one rather than to all of them:
   * `ui.field.*` covers every code the framework's own validators produce, and
   * `taken` and `duplicate` are this API's words, not the framework's.
   *
   * `duplicate` is the interesting one. It is a rule about the *set* of contacts
   * — two rows may not share an address — so no single field's validators can
   * answer it, and the server reports it against the second occurrence. That is
   * the same shape as `taken`, one level deeper.
   *
   * @type {import('@core/foundation/types.js').ReadonlySignal<Readonly<Record<string, string>>>}
   */
  #serverMessages = computed(() => ({
    taken: t('customerForm.error.taken'),
    duplicate: t('customerForm.error.duplicateContact'),
  }));

  get serverMessages() {
    return this.#serverMessages.value;
  }

  /**
   * Translated, and computed so a language change relabels them without a
   * refetch: the values are stable codes and only the labels move.
   *
   * @type {import('@core/foundation/types.js').ReadonlySignal<readonly ComboboxOption[]>}
   */
  #segmentOptions = computed(() =>
    SEGMENTS.map((value) => ({ value, label: t(`customers.segmentValue.${value}`) })),
  );

  get segmentOptions() {
    return this.#segmentOptions.value;
  }

  /* ── Lifecycle ──────────────────────────────────────────────────────────── */

  onMount() {
    void this.#loadCountries();

    // The whole of what view mode is. One effect, so there is no path through
    // this screen that changes the mode and forgets the fields — including the
    // back button, which changes the query and nothing else.
    this.#stopMode = effect(() => {
      this.form.setDisabled(!this.#editing.value);
    });

    // An effect rather than a one-shot load: /new and /:id are one component, so
    // the parameter is the input to watch.
    let previous = /** @type {string | undefined} */ (undefined);
    this.#stopWatching = effect(() => {
      const id = this.customerId;
      if (id === previous) return;
      previous = id;
      if (id === '') {
        this.form.reset();
        this.loadedName.value = '';
      } else void this.load();
    });

    this.#beforeUnload = (event) => {
      if (!this.dirty || this.saving.value) return;
      event.preventDefault();
    };
    globalThis.addEventListener('beforeunload', this.#beforeUnload);
  }

  onDestroy() {
    this.#stopWatching?.();
    this.#stopWatching = undefined;
    this.#stopMode?.();
    this.#stopMode = undefined;
    if (this.#beforeUnload !== undefined) globalThis.removeEventListener('beforeunload', this.#beforeUnload);
    this.#beforeUnload = undefined;
    // A prompt left open would leave the router's guard awaiting a promise
    // nothing can resolve. Being destroyed means the navigation won.
    this.#pendingLeave.value?.(true);
    this.#pendingLeave.value = null;
  }

  /* ── Leaving ────────────────────────────────────────────────────────────── */

  /**
   * The route's `canDeactivate`. Resolves `true` immediately unless there is
   * unsaved work, and otherwise when the user answers the prompt.
   *
   * @returns {boolean | Promise<boolean>}
   */
  canLeave() {
    if (!this.dirty || this.saving.value) return true;
    const already = this.#pendingLeave.value;
    // A second click while the prompt is open is the same question. Answering
    // the first with `false` keeps the router's bookkeeping honest — that
    // navigation really was refused — and leaves the prompt up for this one.
    if (already !== null) already(false);
    return new Promise((resolve) => {
      this.#pendingLeave.value = resolve;
    });
  }

  discard() {
    const resolve = this.#pendingLeave.value;
    this.#pendingLeave.value = null;
    resolve?.(true);
  }

  keepEditing() {
    const resolve = this.#pendingLeave.value;
    this.#pendingLeave.value = null;
    resolve?.(false);
  }

  /* ── Loading ────────────────────────────────────────────────────────────── */

  retry() {
    return this.load();
  }

  /**
   * The one load whose result is not what the screen renders: the fields are the form's,
   * so a settled value is applied to it rather than bound. `reload()` hands the value
   * back for exactly this, and `undefined` means the request was superseded, aborted or
   * rejected — all three of which the resource has already recorded.
   */
  async load() {
    if (this.customerId === '') return;

    const customer = await this.#customer.reload();
    if (customer === undefined || customer === null) return;

    this.form.reset(toValues(customer));
    this.loadedName.value = customer.name;
    this.saveErrorKey.value = '';
  }

  async #loadCountries() {
    try {
      const rows = await inject(LOOKUP_SERVICE).options('country');
      this.countryOptions.value = rows.map((row) => ({ value: String(row.value), label: row.label }));
    } catch {
      // A failed lookup leaves the control empty rather than the screen broken.
      // The field is still required, so the form refuses to save with nothing
      // chosen — and a value already loaded stays pending until the options
      // arrive, which is `ui-combobox`'s half of the contract.
      this.countryOptions.value = [];
    }
  }

  /* ── Saving ─────────────────────────────────────────────────────────────── */

  /** @param {Event} event */
  submit(event) {
    event.preventDefault();
    // View mode has no submit button, but a `<form>` still submits on Enter — and
    // a disabled form reports valid, so this would post the record back to itself
    // unchanged rather than being refused by validation.
    if (this.viewing || this.saving.value || this.loading.value) return;

    this.saveErrorKey.value = '';
    if (!this.form.markSubmitted()) {
      focusInvalidField(this, this.form);
      return;
    }

    const input = toInput(this.form.values);
    const service = inject(SALES_SERVICE);
    const id = this.customerId;

    this.saving.value = true;
    // The values are in flight. Editing one now would be editing something the
    // user is about to be told the server accepted, and `group.values` keeps
    // sending every field, so nothing about the request changes.
    this.form.setDisabled(true);
    void (id === '' ? service.createCustomer(input) : service.updateCustomer(id, input))
      .then((saved) => {
        // Saved, so nothing is unsaved: the baseline moves before the navigation,
        // or `canLeave` prompts on the way out of a form that was just persisted.
        this.form.reset(toValues(saved));
        this.loadedName.value = saved.name;
        // A create has nowhere to stay, so it lands on the list. An edit drops
        // `?edit=true` and stays on the record it just wrote, which is the same
        // screen with the fields switched off — the shortest way to see that the
        // save landed.
        void navigate(id === '' ? '/sales/customers' : `/sales/customers/${encodeURIComponent(id)}`);
      })
      .catch((cause) => {
        // Before anything below looks for a field to focus: a disabled field is
        // not offered as one, so a form still switched off would name nothing
        // and the user would be left with an error and no cursor.
        this.form.setDisabled(false);
        if (!(cause instanceof ApiError)) {
          this.saveErrorKey.value = 'common.saveFailed';
          return;
        }
        const unmatched = this.form.applyErrors(cause.fields);
        if (this.form.firstServerError !== '') {
          this.saveErrorKey.value = 'customerForm.rejected';
          focusInvalidField(this, this.form);
          return;
        }
        // A field the server named and this form does not have. Reported as a
        // plain failure rather than swallowed, because the user is still stuck.
        if (unmatched.length > 0) {
          this.saveErrorKey.value = 'common.saveFailed';
          return;
        }
        this.saveErrorKey.value = cause.forbidden ? 'customerForm.writeForbidden' : 'common.saveFailed';
      })
      .finally(() => {
        this.saving.value = false;
        this.form.setDisabled(false);
      });
  }

  /* ── Switching mode ─────────────────────────────────────────────────────── */

  /**
   * A `navigate` rather than an `<a href>`, for the same reason the list's create
   * control is a button: it has to be renderable and refusable for a session
   * without `sales:write`, and there is no disabled anchor.
   */
  startEdit() {
    if (!this.canWrite || this.creating) return;
    void navigate(`${this.#viewPath}?edit=true`);
  }

  /**
   * Leave edit mode, or leave the screen when there is nothing to go back to.
   *
   * This is the only path that throws work away, which is why the reset is here
   * and not in the mode effect: the back button also leaves edit mode, and a user
   * who backed out of a mistake and returned to it would find the form emptied by
   * a rule nobody told them about. Everywhere else the edits survive, and the
   * route's own prompt still catches them on the way out of the screen.
   */
  cancel() {
    if (this.creating) {
      void navigate('/sales/customers');
      return;
    }
    this.form.reset();
    this.saveErrorKey.value = '';
    void navigate(this.#viewPath);
  }

  get #viewPath() {
    return `/sales/customers/${encodeURIComponent(this.customerId)}`;
  }
}

/**
 * Optional, and a non-negative whole amount when present.
 *
 * Written here rather than composed from `min(0)` because the rule is one
 * sentence in the domain — "revenue, if you know it" — and three framework
 * validators expressing it would each have to re-answer "is it empty".
 *
 * @param {string} value
 * @returns {string}
 */
function nonNegativeAmount(value) {
  if (value.trim() === '') return '';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 'malformed';
  if (amount < 0) return 'tooSmall';
  return amount > 1e12 ? 'tooLarge' : '';
}

/**
 * The form's own shape: strings, because that is what controls hold, and a list
 * of three-string rows for the contacts. The conversion to the API's types
 * happens once, in `toInput`.
 *
 * @typedef {{ name: string, email: string, segment: string, country: string, city: string,
 *   owner: string, since: string, revenue: string, notes: string,
 *   contacts: CustomerContact[] }} CustomerFormValues
 */

/**
 * @param {Customer} customer
 * @returns {CustomerFormValues}
 */
function toValues(customer) {
  return {
    name: customer.name,
    email: customer.email,
    segment: customer.segment,
    country: customer.country,
    city: customer.city,
    owner: customer.owner,
    since: customer.since,
    revenue: String(customer.revenue),
    notes: customer.notes,
    // Copied rather than passed through: `reset` adopts these as the baseline
    // the dirty check compares against, and a baseline sharing objects with the
    // response would move whenever the response did.
    contacts: customer.contacts.map((contact) => ({ ...contact })),
  };
}

/**
 * @param {CustomerFormValues} values
 * @returns {CustomerInput}
 */
function toInput(values) {
  return {
    name: values.name.trim(),
    email: values.email.trim(),
    segment: values.segment,
    country: values.country,
    city: values.city.trim(),
    owner: values.owner.trim(),
    since: values.since,
    revenue: values.revenue.trim() === '' ? 0 : Number(values.revenue),
    notes: values.notes.trim(),
    contacts: values.contacts.map((contact) => ({
      name: contact.name.trim(),
      email: contact.email.trim(),
      role: contact.role,
    })),
  };
}

await defineComponent({
  tag: 'customer-detail-page',
  element: CustomerDetailPage,
  module: import.meta.url,
  uses: [AppCard, AppNotice, UiCombobox, UiDialog, UiField],
});
