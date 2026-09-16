import { navigate, navigationSettled } from '@core/navigation/router.js';
import { configurePreferences, createMemoryStorage } from '@core/preferences/persistence.js';
import { assert, present, settled, unmountAll } from '../../source/lib/test/harness.js';

import { installFakeEventSource, installFakeServer, requested } from './fake-server.js';

/**
 * The customer form: the application's write path, end to end in a real browser.
 *
 * What is asserted here is what a form actually does, rather than that the framework
 * works.
 *
 *   - Errors stay quiet until a field is left, and appear everywhere on submit.
 *   - A rule only the server can check comes back as a 422 and lands under its field.
 *   - The same rule asked while the user types is a debounced check the field owns, and
 *     a submit fired through one waits rather than sending an unchecked value.
 *   - A rule about a set of rows is answered against the array and shown by an element
 *     with no control under it.
 *   - Editing that field clears the server's answer about the previous value.
 *   - Leaving with unsaved work is refusable, and refusing it keeps the URL honest.
 *   - The entitlement is enforced by the route where there is one, and by the screen
 *     where the mode is a query parameter, never by hiding the control.
 *
 * The screen reads as well as writes. `/sales/customers/:id` is view mode and
 * `?edit=true` is edit mode, which is one form with `group.setDisabled()` rather than
 * two renderings of nine fields. The last block asserts that switch from both ends.
 *
 * The assertions are about what the user sees, which is what makes them the check on
 * whether a rewrite of the screen preserved its behaviour.
 *
 * Everything is real except HTTP, including the router, the guards, the session, the
 * components and the compiled templates. `fake-server.js` explains why HTTP is the one
 * boundary that is stubbed.
 */

/** @type {HTMLElement | null} */
let shell = null;
let restoreUrl = '';
/** @type {(() => void) | undefined} */
let restoreFetch;
/** @type {(() => void) | undefined} */
let restoreEventSource;

/** Let a fetch, a signal write and the render it causes land. */
async function tick() {
  for (let index = 0; index < 8; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Navigate, discarding unsaved work if the form asks.
 *
 * The navigation is not awaited first. With a dirty form the route's `canDeactivate`
 * is holding a promise open until the prompt is answered, so awaiting before answering
 * deadlocks. That is what the guard is rather than a quirk of the test, and every case
 * below that starts by leaving a dirty form goes through here.
 *
 * @param {string} path
 */
async function goto(path) {
  const arrival = navigate(path);
  await tick();
  if (leavePrompt() !== null) clickPrompt('Discard them');
  await arrival;
  const view = main().firstElementChild;
  if (view !== null) await settled(view);
  await tick();
}

/** The unsaved-changes prompt, or null when the form is not asking. */
function leavePrompt() {
  return main().querySelector('customer-detail-page [role="alertdialog"]');
}

/** @param {string} label */
function clickPrompt(label) {
  const prompt = present(leavePrompt(), 'the form is not asking anything');
  const button = present(
    [...prompt.querySelectorAll('button')].find((candidate) => present(candidate.textContent).trim() === label),
    `no "${label}" button in the prompt`,
  );
  /** @type {HTMLButtonElement} */ (button).click();
}

/** @returns {Element} */
function main() {
  return present(present(shell).querySelector('main'), 'app-root rendered no <main> outlet');
}

/** @param {string} password `admin` for every scope, `viewer` for the read-only role. */
async function signIn(password) {
  await goto('/login');
  const form = present(main().querySelector('form'), 'login form must render');
  /** @type {HTMLInputElement} */ (present(form.querySelector('input[name="username"]'))).value = 'ada';
  /** @type {HTMLInputElement} */ (present(form.querySelector('input[name="password"]'))).value = password;
  form.dispatchEvent(new SubmitEvent('submit', { cancelable: true, bubbles: true }));
  await tick();
  await navigationSettled();
  await tick();
}

async function signOut() {
  await goto('/');
  await tick();
  const menu = present(main().querySelector('ui-menu[label]'), 'no user menu');
  const button = present([...menu.querySelectorAll('button')].at(-1), 'no sign-out control');
  /** @type {HTMLButtonElement} */ (button).click();
  await tick();
  await navigationSettled();
  await tick();
}

/** @returns {Element} */
function form() {
  return present(main().querySelector('customer-detail-page form'), 'the customer form must mount');
}

/**
 * Type into a field the way a user does. Set the value, then dispatch the event the
 * binding listens for. Assigning `.value` alone changes the DOM and tells the component
 * nothing, which is exactly the bug this helper exists not to hide.
 *
 * @param {string} name
 * @param {string} value
 */
async function type(name, value) {
  const field = present(form().querySelector(`#cf-${name}`), `no field ${name}`);
  const control = /** @type {HTMLInputElement | HTMLTextAreaElement} */ (field);
  control.value = value;
  control.dispatchEvent(new Event('input', { bubbles: true }));
  await tick();
}

/** @param {string} name */
async function blur(name) {
  const field = present(form().querySelector(`#cf-${name}`), `no field ${name}`);
  field.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
  await tick();
}

/**
 * Choose an option in one of the two comboboxes. The panel is opened through the
 * control's own pointer handling rather than by calling a method, so what is exercised
 * is the element's interface and not its internals.
 *
 * @param {string} name
 * @param {string} label
 */
async function choose(name, label) {
  const combobox = present(form().querySelector(`#cf-${name}`), `no combobox ${name}`);
  const control = present(combobox.querySelector('[data-ui-part="combobox-control"]'));
  control.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  await tick();

  const option = present(
    [...combobox.querySelectorAll('[data-ui-part="combobox-option"]')].find(
      (candidate) => present(candidate.textContent).trim() === label,
    ),
    `no option "${label}" in ${name}`,
  );
  option.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  await tick();
}

/**
 * The error text under one field, or the empty string.
 *
 * One lookup for every field, including the two comboboxes. Without `ui-field` and the
 * form-control contract this would need a second branch, because a combobox generates
 * the node that takes focus, so nothing could carry the error's id and nothing could
 * point `aria-describedby` at it. The single branch here is the assertion that it
 * can.
 *
 * @param {string} name
 */
function errorOf(name) {
  const paragraph = form().querySelector(`#cf-${name}-error`);
  return paragraph === null ? '' : present(paragraph.textContent).trim();
}

function submit() {
  form().dispatchEvent(new SubmitEvent('submit', { cancelable: true, bubbles: true }));
}

/** The header's Edit control. Present in view mode only, disabled without `sales:write`. */
function editButton() {
  const page = present(main().querySelector('customer-detail-page'), 'the screen must mount');
  return /** @type {HTMLButtonElement} */ (
    present([...page.querySelectorAll('[slot="actions"] button')].at(0), 'the header must offer an edit control')
  );
}

/** The submit control, or null. Edit mode renders it; view mode has nothing to save. */
function saveButton() {
  return [...form().querySelectorAll('button')].find((button) => button.type === 'submit') ?? null;
}

/* ── Contacts, the repeating row ────────────────────────────────────────────
 *
 * Reached by path rather than by id. The nine fields above each have a written `#cf-*`
 * id, which is exactly what a repeating row cannot have, because the second row would
 * carry the same one. What identifies a row's field instead is the path it occupies,
 * such as `contacts.1.email`, which is the string the array produces, the string a 422
 * carries, and the string `<ui-field name>` is bound to. These helpers look it up the
 * same way `focusInvalidField` does.
 */

/** @param {string} path */
function contactField(path) {
  return present(form().querySelector(`ui-field[name="${path}"]`), `no contact field ${path}`);
}

/** Every contact row currently on screen. */
function contactRows() {
  return [...form().querySelectorAll('ui-field[name^="contacts."][name$=".name"]')];
}

/**
 * @param {string} path
 * @param {string} value
 */
async function typeContact(path, value) {
  const control = /** @type {HTMLInputElement | HTMLSelectElement} */ (
    present(contactField(path).querySelector('input, select'), `no control under ${path}`)
  );
  control.value = value;
  control.dispatchEvent(new Event('input', { bubbles: true }));
  await tick();
}

/** @param {string} path */
function errorOfContact(path) {
  const paragraph = contactField(path).querySelector('p[role="alert"]');
  return paragraph === null ? '' : present(paragraph.textContent).trim();
}

/**
 * The contacts array's own error, which belongs to no row and has no control.
 *
 * A rule about the set of rows has nothing to sit under, so `<ui-form-error>` shows
 * it, as a paragraph and a name, where a field would be a label, a control and an
 * error.
 */
function errorOfContacts() {
  const paragraph = form().querySelector('ui-form-error[name="contacts"] p[role="alert"]');
  return paragraph === null ? '' : present(paragraph.textContent).trim();
}

/**
 * Wait out an asynchronous check, which is 300 ms of debounce and then a request.
 *
 * `tick()` covers 80 ms, deliberately less than the quiet window. A check that
 * fired inside it would be one keystroke away from firing on every keystroke, and
 * that is the behaviour the debounce exists to prevent.
 */
async function checked() {
  await new Promise((resolve) => setTimeout(resolve, 400));
  await tick();
}

/** @param {string} label */
async function clickButton(label) {
  const button = present(
    [...form().querySelectorAll('button')].find((candidate) => present(candidate.textContent).trim() === label),
    `no "${label}" control`,
  );
  /** @type {HTMLButtonElement} */ (button).click();
  await tick();
}

/**
 * A create form nothing has touched.
 *
 * Going straight to `/sales/customers/new` is not enough when the previous case left
 * the screen there. Navigating to the URL that is already matched is a re-render rather
 * than a navigation, which is the behaviour `?edit=true` relies on, so the element is
 * not replaced and neither is the form inside it. Leaving the route first is what makes
 * the next arrival a fresh mount.
 */
async function newCustomerForm() {
  await goto('/sales/customers');
  await goto('/sales/customers/new');
}

/**
 * @param {number} index
 * @param {{ name: string, email: string, role: string }} values
 */
async function fillContact(index, values) {
  await typeContact(`contacts.${index}.name`, values.name);
  await typeContact(`contacts.${index}.email`, values.email);
  await typeContact(`contacts.${index}.role`, values.role);
}

/** Numbers the values `fillValid` writes, so no two calls save the same customer. */
let filled = 0;

/**
 * Fill every required field with something acceptable, and settle what that starts.
 *
 * The address is checked against the server, so a form filled in this way is pending
 * for the length of the debounce plus the request. A case that submitted before that
 * would be testing the wait rather than its own subject, and one case below does
 * exactly that, deliberately.
 *
 * The name and the address are numbered, because a case that saves leaves a
 * customer behind and the next case's form would then be told its own suite's
 * record is the clash. Every case that wants a clash asks for one by name.
 */
async function fillValid() {
  filled += 1;
  await type('name', `Caelum Energy ${filled}`);
  await type('email', `hello.${filled}@caelum.example`);
  await choose('segment', 'Enterprise');
  await choose('country', 'IT');
  await type('city', 'Torino');
  await type('owner', 'Ada Rossi');
  await type('since', '2025-03-01');
  await checked();
}

describe('customer form', () => {
  before(async () => {
    restoreUrl = location.pathname + location.search;
    restoreFetch = installFakeServer();
    restoreEventSource = installFakeEventSource();
    configurePreferences({ storage: createMemoryStorage() });
    history.replaceState(null, '', '/login?lang=en');

    await import('../src/main.js');
    shell = document.createElement('app-root');
    document.body.append(shell);
    await settled(shell);
    await navigationSettled();
  });

  after(() => {
    shell?.remove();
    shell = null;
    restoreFetch?.();
    restoreEventSource?.();
    configurePreferences({});
    history.replaceState(null, '', restoreUrl);
    unmountAll();
  });

  it('keeps errors quiet until a field is left', async () => {
    await signIn('admin');
    await goto('/sales/customers/new');

    assert.equal(errorOf('name'), '', 'an untouched field must not be marked wrong');

    // Touched and empty is the case an error belongs to, because the user has been
    // there and left it blank, which is a decision rather than a field they have not
    // reached.
    await blur('name');
    assert.equal(errorOf('name'), 'This field is required.');
    assert.equal(errorOf('email'), '', 'a field the user has not reached stays quiet');
  });

  it('shows every error on submit and sends nothing', async () => {
    await goto('/sales/customers/new');
    const before = requested.length;

    submit();
    await tick();

    assert.equal(errorOf('email'), 'This field is required.');
    assert.equal(errorOf('city'), 'This field is required.');
    assert.equal(errorOf('segment'), 'This field is required.', 'a combobox is a field like any other');
    assert.notOk(
      requested.slice(before).some((entry) => entry.startsWith('POST /api/customers')),
      'an invalid form must not reach the network',
    );
  });

  it('reports a malformed email without asking the server', async () => {
    await goto('/sales/customers/new');
    await type('email', 'not-an-address');
    await blur('email');
    assert.equal(errorOf('email'), 'That is not a valid value.');

    await type('email', 'hello@caelum.example');
    assert.equal(errorOf('email'), '', 'correcting the value clears the error');
  });

  it('asks the server about an address while the user types', async () => {
    // Uniqueness is a rule no client holds the data for, and the 422 at submit is
    // still the authority. The check only moves the common case forward, so the
    // user learns at the second field instead of after filling in nine.
    await newCustomerForm();
    await type('email', 'aurora.utilities@example.com');
    await blur('email');

    assert.equal(errorOf('email'), '', 'nothing is asked inside the quiet window');

    await checked();
    assert.ok(
      requested.some((entry) => entry.startsWith('GET /api/customers/email-available')),
      'the check must reach the server',
    );
    assert.equal(errorOf('email'), 'Another customer already uses this.');

    await type('email', 'free@caelum.example');
    assert.equal(errorOf('email'), '', 'a new value has no answer yet, so it shows none');
    await checked();
    assert.equal(errorOf('email'), '', 'and a free address stays clear');
  });

  it('does not ask about a malformed address, or about one the server sent', async () => {
    await newCustomerForm();
    const before = requested.length;

    await type('email', 'not-an-address');
    await blur('email');
    await checked();
    assert.equal(errorOf('email'), 'That is not a valid value.', 'the synchronous rule answers first');
    assert.notOk(
      requested.slice(before).some((entry) => entry.startsWith('GET /api/customers/email-available')),
      'and a value that cannot be right is not worth a round trip',
    );

    // A saved customer's own address would otherwise be reported as taken by the
    // record that holds it, which is the one form that must never say so.
    const loaded = requested.length;
    await goto('/sales/customers/CU-0001?edit=true');
    await checked();
    assert.equal(errorOf('email'), '', 'a loaded value is the server’s own and is not re-asked');
    assert.notOk(
      requested.slice(loaded).some((entry) => entry.startsWith('GET /api/customers/email-available')),
      'nothing is asked for a value a load installed',
    );
  });

  it('holds a submit until the check it started has settled', async () => {
    await newCustomerForm();
    await fillValid();
    // Typed and submitted in the same breath, which is the case that sends an
    // unchecked value if `pending` counts as valid. The submit is inside the quiet
    // window, so nothing has even been asked yet when it fires.
    await type('email', 'aurora.utilities@example.com');
    const before = requested.length;

    submit();
    await checked();

    assert.notOk(
      requested.slice(before).some((entry) => entry.startsWith('POST /api/customers')),
      'the submit waits for the answer rather than racing it',
    );
    assert.equal(errorOf('email'), 'Another customer already uses this.');
    assert.equal(location.pathname, '/sales/customers/new', 'and the form keeps the user');
  });

  it('creates a customer and returns to the list', async () => {
    await newCustomerForm();
    await fillValid();

    submit();
    await tick();
    await navigationSettled();
    await tick();

    assert.ok(requested.includes('POST /api/customers'), 'the create must be posted');
    assert.equal(location.pathname, '/sales/customers', 'a saved form returns to the list');
  });

  it('puts a server-only rule under the field that broke it', async () => {
    await goto('/sales/customers/new');
    await fillValid();
    // Uniqueness is the rule this side cannot check, because the name belongs to a
    // customer the client has never fetched. The form believes it is valid and posts
    // it.
    await type('name', 'Aurora Utilities');

    submit();
    await tick();

    assert.ok(requested.includes('POST /api/customers'), 'the form must post what it believes is valid');
    assert.equal(location.pathname, '/sales/customers/new', 'a refused save stays on the form');
    assert.equal(errorOf('name'), 'Another customer already uses this.');

    // The server answered about the previous value, so the answer stops applying the
    // moment the value changes — otherwise a corrected name keeps a stale error.
    await type('name', 'Caelum Energy');
    assert.equal(errorOf('name'), '', 'editing the field clears the server error');
  });

  it('adds and removes a contact, and counts both as unsaved work', async () => {
    await newCustomerForm();
    assert.equal(contactRows().length, 0, 'a new customer starts with no contacts');
    assert.notOk(
      [...form().querySelectorAll('p')].some((node) => present(node.textContent).includes('Unsaved')),
      'and is not dirty before anything is done to it',
    );

    await clickButton('Add contact');
    assert.equal(contactRows().length, 1);
    assert.ok(
      [...form().querySelectorAll('p')].some((node) => present(node.textContent).includes('Unsaved')),
      'an empty row the user asked for is an unsaved change, not nothing',
    );

    await clickButton('Remove');
    assert.equal(contactRows().length, 0, 'and taking it away again undoes it');
  });

  it('keeps a row error under its own row', async () => {
    await newCustomerForm();
    await fillValid();
    await clickButton('Add contact');
    await clickButton('Add contact');
    await fillContact(0, { name: 'Grace Bianchi', email: 'grace@caelum.example', role: 'billing' });

    submit();
    await tick();

    assert.equal(errorOfContact('contacts.0.name'), '', 'the row that was filled in says nothing');
    assert.equal(
      errorOfContact('contacts.1.name'),
      'This field is required.',
      'and the row that was not says so under itself',
    );
    assert.equal(errorOfContact('contacts.1.email'), 'This field is required.');
    assert.equal(errorOfContact('contacts.1.role'), 'This field is required.');
  });

  it('renumbers the rows when one in the middle is removed', async () => {
    await newCustomerForm();
    await clickButton('Add contact');
    await clickButton('Add contact');
    await fillContact(0, { name: 'Grace Bianchi', email: 'grace@caelum.example', role: 'billing' });
    await fillContact(1, { name: 'Alan Verdi', email: 'alan@caelum.example', role: 'technical' });

    const remove = form().querySelectorAll('button[aria-label="Remove this contact"]');
    /** @type {HTMLButtonElement} */ (present(remove[0])).click();
    await tick();

    assert.equal(contactRows().length, 1);
    const survivor = /** @type {HTMLInputElement} */ (
      present(contactField('contacts.0.name').querySelector('input'))
    );
    assert.equal(survivor.value, 'Alan Verdi', 'the second row is now the first, values and all');
  });

  it('answers a rule about the set of rows without naming one', async () => {
    // Two contacts may not share an address. `uniqueBy('email')` on the array is
    // that rule, and it belongs to the array because no row is more to blame than
    // the other. So there is no control to put the message under, and the element
    // that shows it is a paragraph with a name and nothing else.
    await newCustomerForm();
    await fillValid();
    await type('name', 'Nimbus Freight');
    await type('email', 'hello@nimbus.example');
    await clickButton('Add contact');
    await clickButton('Add contact');
    await fillContact(0, { name: 'Grace Bianchi', email: 'same@caelum.example', role: 'billing' });
    await fillContact(1, { name: 'Alan Verdi', email: 'same@caelum.example', role: 'technical' });
    const before = requested.length;

    submit();
    await checked();

    assert.notOk(
      requested.slice(before).some((entry) => entry.startsWith('POST /api/customers')),
      'the client can answer this one, so nothing is sent',
    );
    assert.equal(errorOfContacts(), 'Another contact already uses this address.');
    assert.equal(errorOfContact('contacts.0.email'), '', 'and neither row is blamed for it');
    assert.equal(errorOfContact('contacts.1.email'), '');
    assert.equal(
      document.activeElement?.getAttribute('name'),
      'contacts',
      'a refused submit focuses the message, because there is no control to focus',
    );

    await typeContact('contacts.1.email', 'alan@caelum.example');
    await tick();
    assert.equal(errorOfContacts(), '', 'and the edit that resolves the clash clears it');
  });

  it('still takes the server’s answer about a row when the client’s rule misses it', async () => {
    // `uniqueBy` compares the values as typed and the server compares them folded,
    // so two addresses differing only in case pass here and clash there. The rule
    // the client runs is a courtesy; the server is the authority, and its answer
    // arrives by path and lands under the row that repeats.
    await newCustomerForm();
    await fillValid();
    await type('name', 'Zephyr Rail');
    await type('email', 'hello@zephyr.example');
    await clickButton('Add contact');
    await clickButton('Add contact');
    await fillContact(0, { name: 'Grace Bianchi', email: 'shared@caelum.example', role: 'billing' });
    await fillContact(1, { name: 'Alan Verdi', email: 'SHARED@caelum.example', role: 'technical' });

    submit();
    await checked();

    assert.equal(errorOfContacts(), '', 'the client sees two different addresses');
    assert.ok(requested.includes('POST /api/customers'), 'so it posts what it believes is valid');
    assert.equal(location.pathname, '/sales/customers/new', 'a refused save stays on the form');
    assert.equal(errorOfContact('contacts.0.email'), '', 'the first use of the address is not the problem');
    assert.equal(errorOfContact('contacts.1.email'), 'Another contact already uses this address.');
    assert.equal(
      document.activeElement?.closest('ui-field')?.getAttribute('name'),
      'contacts.1.email',
      'and the caret is in the control that caused it, two levels down',
    );

    await typeContact('contacts.1.email', 'alan@caelum.example');
    assert.equal(errorOfContact('contacts.1.email'), '', 'editing the row clears the server answer about it');
  });

  it('loads the contacts a customer has, and switches them off with the form', async () => {
    await goto('/sales/customers/CU-0001');

    assert.equal(contactRows().length, 1, 'the customer has one contact');
    const name = /** @type {HTMLInputElement} */ (
      present(contactField('contacts.0.name').querySelector('input'))
    );
    assert.equal(name.value, 'Grace Bianchi');
    assert.ok(name.disabled, 'view mode switches a row off like every other field');
    assert.notOk(
      [...form().querySelectorAll('button')].some(
        (button) => present(button.textContent).trim() === 'Add contact',
      ),
      'and offers nothing to add to it',
    );
  });

  it('loads an existing customer and tracks unsaved changes', async () => {
    await goto('/sales/customers/CU-0001?edit=true');

    const name = /** @type {HTMLInputElement} */ (present(form().querySelector('#cf-name')));
    assert.equal(name.value, 'Aurora Utilities', 'the form must load the customer');
    assert.notOk(form().querySelector('p[role="alert"]'), 'a freshly loaded form shows no errors');
    assert.notOk(
      [...form().querySelectorAll('p')].some((node) => present(node.textContent).includes('Unsaved')),
      'and is not dirty until something is edited',
    );

    await type('city', 'Bologna');
    const dirty = present(
      [...form().querySelectorAll('p')].find((node) => present(node.textContent).includes('Unsaved')),
      'an edited form must say so',
    );
    assert.includes(present(dirty.textContent), 'Unsaved changes');

    submit();
    await tick();
    await navigationSettled();
    await tick();

    assert.ok(requested.includes('PATCH /api/customers/CU-0001'), 'the update must be patched');
    assert.equal(
      location.pathname + location.search,
      '/sales/customers/CU-0001',
      'a saved edit drops the mode and stays on the record',
    );
    assert.ok(
      /** @type {HTMLInputElement} */ (present(form().querySelector('#cf-name'))).disabled,
      'which is view mode: the fields are switched off again',
    );
  });

  it('refuses to be left with unsaved changes, and keeps the URL honest', async () => {
    await goto('/sales/customers/CU-0001?edit=true');
    await type('city', 'Genova');

    // Not awaited, because the guard is holding this navigation open until the prompt
    // is answered, which is the behaviour under test.
    const leaving = navigate('/sales/customers');
    await tick();

    assert.ok(leavePrompt(), 'a dirty form must ask before it is abandoned');
    clickPrompt('Keep editing');
    await leaving;
    await tick();

    assert.equal(
      location.pathname + location.search,
      '/sales/customers/CU-0001?edit=true',
      'a refused navigation puts the URL back, mode and all',
    );
    assert.ok(main().querySelector('customer-detail-page'), 'and leaves the form mounted');
    const city = /** @type {HTMLInputElement} */ (present(form().querySelector('#cf-city')));
    assert.equal(city.value, 'Genova', 'with the edit intact');

    // Answering the other way lets it through, and the form is gone.
    const second = navigate('/sales/customers');
    await tick();
    clickPrompt('Discard them');
    await second;
    await tick();

    assert.equal(location.pathname, '/sales/customers');
    assert.notOk(main().querySelector('customer-detail-page'), 'the form must be released');
  });

  it('does not ask when there is nothing unsaved', async () => {
    await goto('/sales/customers/CU-0001?edit=true');

    const leaving = navigate('/sales/customers');
    await tick();
    assert.notOk(leavePrompt(), 'a clean form must not interrupt a navigation');
    await leaving;
    await tick();

    assert.equal(location.pathname, '/sales/customers');
  });

  /* ── View mode ────────────────────────────────────────────────────────── */

  it('opens a customer read-only, with every control switched off', async () => {
    await goto('/sales/customers/CU-0001');

    const name = /** @type {HTMLInputElement} */ (present(form().querySelector('#cf-name')));
    assert.equal(name.value, 'Aurora Utilities', 'view mode is the same form, filled in');
    assert.ok(name.disabled, 'and not editable');
    assert.ok(
      present(form().querySelector('ui-field[name="name"]')).hasAttribute('data-disabled'),
      'the field publishes the state its label is dimmed by',
    );
    assert.ok(
      /** @type {import('@components/inputs/ui-combobox.js').UiCombobox} */ (
        present(form().querySelector('#cf-country'))
      ).disabled,
      'including the control that renders its own input',
    );
    assert.notOk(saveButton(), 'there is nothing to save');
  });

  it('leaves a required field with no error while it is read-only', async () => {
    // The rules still fail, since `revenue` is the only optional one, and saying so
    // would be telling the user to fix a form they cannot touch.
    await goto('/sales/customers/CU-0001');

    submit();
    await tick();

    assert.equal(errorOf('name'), '', 'a disabled field answers for nothing');
    assert.equal(location.pathname, '/sales/customers/CU-0001', 'and Enter on a read-only form goes nowhere');
  });

  it('switches to edit mode from the header, and back out again', async () => {
    await goto('/sales/customers/CU-0001');
    editButton().click();
    await tick();

    assert.equal(location.pathname + location.search, '/sales/customers/CU-0001?edit=true', 'the mode is the URL');
    const name = /** @type {HTMLInputElement} */ (present(form().querySelector('#cf-name')));
    assert.notOk(name.disabled, 'the same form the user was reading is now editable');
    assert.ok(saveButton(), 'and can be saved');

    // Cancel is the one path that throws work away, which is why it is a button
    // and not the back arrow.
    const loaded = /** @type {HTMLInputElement} */ (present(form().querySelector('#cf-city'))).value;
    await type('city', 'Verona');
    /** @type {HTMLButtonElement} */ (
      present([...form().querySelectorAll('button')].find((button) => present(button.textContent).trim() === 'Cancel'))
    ).click();
    await tick();

    assert.equal(location.pathname + location.search, '/sales/customers/CU-0001');
    const city = /** @type {HTMLInputElement} */ (present(form().querySelector('#cf-city')));
    assert.ok(city.disabled);
    assert.equal(city.value, loaded, 'and the abandoned edit is gone');
  });

  it('keeps an edit that was only backed out of, and still asks about it on the way out', async () => {
    // Leaving edit mode is a query change, which this router does not consider a
    // navigation, so nothing can prompt about it. Discarding silently would be the
    // wrong answer, so the work stays and the guard that does run catches it.
    await goto('/sales/customers/CU-0001?edit=true');
    await type('city', 'Trieste');
    await goto('/sales/customers/CU-0001');

    const city = /** @type {HTMLInputElement} */ (present(form().querySelector('#cf-city')));
    assert.equal(city.value, 'Trieste', 'backing out of edit mode is not a discard');
    assert.ok(city.disabled, 'though it is read-only again');

    const leaving = navigate('/sales/customers');
    await tick();
    assert.ok(leavePrompt(), 'and leaving the screen still asks');
    clickPrompt('Discard them');
    await leaving;
    await tick();
  });

  it('offers a viewer the record but not the edit, and refuses the mode in the URL', async () => {
    await signOut();
    await signIn('viewer');
    await goto('/sales/customers/CU-0001');

    assert.ok(main().querySelector('customer-detail-page'), 'reading a customer needs sales:read, which a viewer has');
    assert.ok(
      /** @type {HTMLButtonElement} */ (editButton()).disabled,
      'the edit control is rendered and disabled: a missing button reads as a broken one',
    );

    // A query parameter cannot be a route guard, so the screen is what refuses. The
    // server refuses the write itself, as the header of `example/server/api.mjs`
    // says.
    await goto('/sales/customers/CU-0001?edit=true');
    assert.ok(
      /** @type {HTMLInputElement} */ (present(form().querySelector('#cf-name'))).disabled,
      'a typed URL must not open a form whose save is going to be refused',
    );
    assert.notOk(saveButton(), 'and there is nothing to submit');

    // Creating is still a route, so it is still the route that says no.
    await goto('/sales/customers/new');
    assert.equal(location.pathname, '/forbidden', 'the guard must refuse the create path');
    assert.notOk(main().querySelector('customer-detail-page'), 'the form must not mount');

    await goto('/sales/customers');
    const list = present(main().querySelector('customers-page'));
    const create = present(
      [...list.querySelectorAll('button')].find((button) => present(button.textContent).includes('New customer')),
      'the create control must still be rendered for a viewer',
    );
    assert.ok(/** @type {HTMLButtonElement} */ (create).disabled, 'and must be disabled with a reason');
  });
});
