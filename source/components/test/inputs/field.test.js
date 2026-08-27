import { field } from '@core/forms/field.js';
import { group } from '@core/forms/group.js';
import { required } from '@core/forms/validators.js';
import { assert, mount, present, settled, unmountAll } from '../../../lib/test/harness.js';
import { useStandardText } from '../standard-text.js';
import { focusInvalidField } from '@components/inputs/ui-field.js';
import '@components/inputs/ui-combobox.js';

/** @import { UiField } from '@components/inputs/ui-field.js' */
/** @import { UiCombobox } from '@components/inputs/ui-combobox.js' */

/**
 * `ui-field`, against both kinds of control it understands.
 *
 * The native case is the easy half and is here mostly as the control: if a plain
 * `<input>` did not work there would be no reason to trust the other one. The
 * combobox case is the reason the element exists — ADR-0011 records the four
 * separate frictions a screen hit wiring one by hand, and each of them is an
 * assertion below.
 */

/** @param {HTMLElement} element */
async function tick(element) {
  await settled(element);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await settled(element);
}

describe('ui-field', () => {
  beforeEach(() => {
    useStandardText();
  });

  afterEach(() => {
    unmountAll();
  });

  it('binds a native input in both directions', async () => {
    const host = /** @type {UiField} */ (
      mount('<ui-field label="City"><input id="city-input" /></ui-field>')
    );
    const city = field('Milano');
    host.field = city;
    await settled(host);

    const input = /** @type {HTMLInputElement} */ (present(host.querySelector('input')));
    assert.equal(input.value, 'Milano', 'the field fills the control');

    input.value = 'Torino';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    assert.equal(city.value.value, 'Torino', 'and the control writes back');

    city.setValue('Genova');
    await settled(host);
    assert.equal(input.value, 'Genova', 'a value set in code reaches the control');
  });

  it('marks the field touched when the control is left', async () => {
    const host = /** @type {UiField} */ (mount('<ui-field label="City"><input /></ui-field>'));
    const city = field('', [required()]);
    host.field = city;
    await settled(host);

    assert.notOk(city.touched.value);
    // Capture, because blur does not bubble: a listener that waited for it to
    // arrive at `ui-field` would never hear it.
    present(host.querySelector('input')).dispatchEvent(new FocusEvent('blur'));
    assert.ok(city.touched.value);
  });

  it('shows the error only once it may be shown, and wires the ARIA to it', async () => {
    const host = /** @type {UiField} */ (
      mount('<ui-field label="City"><input id="city-input" /></ui-field>')
    );
    const city = field('', [required()]);
    host.field = city;
    await settled(host);

    const input = present(host.querySelector('input'));
    assert.notOk(host.querySelector('p[role="alert"]'), 'nothing is wrong yet as far as the user is concerned');
    assert.equal(input.getAttribute('aria-invalid'), 'false');
    assert.notOk(input.hasAttribute('aria-describedby'));

    city.touch();
    await settled(host);

    const alert = present(host.querySelector('p[role="alert"]'), 'the error must appear');
    assert.equal(present(alert.textContent).trim(), 'Required', 'resolved from standard text, not shipped here');
    assert.equal(alert.id, 'city-input-error', 'the id is derived from the control the caller named');
    assert.equal(input.getAttribute('aria-invalid'), 'true');
    assert.equal(input.getAttribute('aria-describedby'), 'city-input-error');
  });

  it('prefers a caller-supplied message for a code the collection does not know', async () => {
    const host = /** @type {UiField} */ (mount('<ui-field label="Name"><input /></ui-field>'));
    const name = field('Aurora');
    host.field = name;
    host.messages = { taken: 'Another customer already uses this.' };
    name.serverError.value = 'taken';
    await settled(host);

    assert.equal(
      present(present(host.querySelector('p[role="alert"]')).textContent).trim(),
      'Another customer already uses this.',
    );
  });

  it('associates the label with the control', async () => {
    const host = /** @type {UiField} */ (
      mount('<ui-field label="City"><input id="city-input" /></ui-field>')
    );
    host.field = field('');
    await settled(host);

    assert.equal(present(host.querySelector('label')).getAttribute('for'), 'city-input');
  });

  it('shows a hint until an error replaces it', async () => {
    const host = /** @type {UiField} */ (
      mount('<ui-field label="Notes" hint="0 of 280"><input id="notes-input" /></ui-field>')
    );
    const notes = field('', [required()]);
    host.field = notes;
    await settled(host);

    const input = present(host.querySelector('input'));
    assert.equal(input.getAttribute('aria-describedby'), 'notes-input-hint');

    notes.touch();
    await settled(host);
    assert.notOk(host.querySelector('#notes-input-hint'), 'the error takes the place of the hint');
    assert.equal(input.getAttribute('aria-describedby'), 'notes-input-error');
  });

  it('switches a native control off with its field, and publishes the state', async () => {
    const host = /** @type {UiField} */ (
      mount('<ui-field label="Revenue"><input id="revenue-input" /></ui-field>')
    );
    const revenue = field('120', [required()]);
    host.field = revenue;
    await settled(host);

    const input = /** @type {HTMLInputElement} */ (present(host.querySelector('input')));
    assert.notOk(input.disabled);
    assert.notOk(host.hasAttribute('data-disabled'));

    revenue.setDisabled(true);
    await settled(host);
    assert.ok(input.disabled);
    assert.ok(host.hasAttribute('data-disabled'), 'the label and the error are this element to dim');

    revenue.setDisabled(false);
    await settled(host);
    assert.notOk(input.disabled, 'the property, not the attribute: an attribute never comes back off');
    assert.notOk(host.hasAttribute('data-disabled'));
  });

  it('hides the error of a field that was disabled while it was showing one', async () => {
    const host = /** @type {UiField} */ (mount('<ui-field label="City"><input /></ui-field>'));
    const city = field('', [required()]);
    host.field = city;
    city.touch();
    await settled(host);
    assert.ok(host.querySelector('p[role="alert"]'));

    city.setDisabled(true);
    await settled(host);
    assert.notOk(host.querySelector('p[role="alert"]'), 'there is no control to correct');
    assert.equal(present(host.querySelector('input')).getAttribute('aria-invalid'), 'false');
  });

  /* ── The custom-control contract ──────────────────────────────────────── */

  it('binds a combobox as codes rather than options', async () => {
    const host = /** @type {UiField} */ (
      mount('<ui-field label="Country"><ui-combobox id="country-input"></ui-combobox></ui-field>')
    );
    const combobox = /** @type {UiCombobox} */ (present(host.querySelector('ui-combobox')));
    combobox.options = [
      { value: 'IT', label: 'Italy' },
      { value: 'DE', label: 'Germany' },
    ];
    const country = field('');
    host.field = country;
    await tick(host);

    country.setValue('DE');
    await tick(host);
    assert.equal(combobox.formValue, 'DE');
    // Single choice, so the label is the input's own text and there is no chip:
    // the point is that the code resolved to an option and the user sees a name.
    assert.notOk(
      combobox.querySelector('[data-ui-part="combobox-chip"]'),
      'one answer is not a chip',
    );
    assert.equal(
      /** @type {HTMLInputElement} */ (present(combobox.querySelector('[data-ui-part="combobox-input"]'))).value,
      'Germany',
      'the code became the option, so the control shows a label',
    );

    // And back: choosing an option writes the code, not the object.
    present(combobox.querySelector('[data-ui-part="combobox-control"]')).dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true }),
    );
    await tick(host);
    const italy = present(
      [...combobox.querySelectorAll('[data-ui-part="combobox-option"]')].find(
        (option) => present(option.textContent).trim() === 'Italy',
      ),
    );
    italy.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await tick(host);

    assert.equal(country.value.value, 'IT');
  });

  it('keeps a value set before the options arrive', async () => {
    // A form fills its fields from a record that arrives before the lookup that
    // explains it. Dropping the code here is how a loaded form shows an empty
    // country and then saves it that way.
    const host = /** @type {UiField} */ (
      mount('<ui-field label="Country"><ui-combobox id="country-input"></ui-combobox></ui-field>')
    );
    const combobox = /** @type {UiCombobox} */ (present(host.querySelector('ui-combobox')));
    host.field = field('IT');
    await tick(host);

    assert.equal(combobox.formValue, '', 'nothing to show while no option explains the code');

    combobox.options = [{ value: 'IT', label: 'Italy' }];
    await tick(host);
    assert.equal(combobox.formValue, 'IT', 'and it appears when the lookup lands');
  });

  it('points the generated input at the label and the error', async () => {
    const host = /** @type {UiField} */ (
      mount('<ui-field label="Country"><ui-combobox id="country-input"></ui-combobox></ui-field>')
    );
    const combobox = /** @type {UiCombobox} */ (present(host.querySelector('ui-combobox')));
    const country = field('', [required()]);
    host.field = country;
    await tick(host);

    const inner = present(combobox.querySelector('[data-ui-part="combobox-input"]'));
    const label = present(host.querySelector('label'));
    assert.equal(label.getAttribute('for'), null, 'a label may not name a custom element');
    assert.equal(inner.getAttribute('aria-labelledby'), label.id, 'so the association is made from inside');

    country.touch();
    await tick(host);
    assert.equal(inner.getAttribute('aria-invalid'), 'true');
    assert.equal(inner.getAttribute('aria-describedby'), 'country-input-error');
  });

  it('switches a combobox off through the contract, and shuts its panel', async () => {
    const host = /** @type {UiField} */ (
      mount('<ui-field label="Country"><ui-combobox id="country-input"></ui-combobox></ui-field>')
    );
    const combobox = /** @type {UiCombobox} */ (present(host.querySelector('ui-combobox')));
    combobox.options = [{ value: 'IT', label: 'Italy' }];
    const country = field('');
    host.field = country;
    await tick(host);

    present(combobox.querySelector('[data-ui-part="combobox-control"]')).dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true }),
    );
    await tick(host);
    assert.ok(combobox.open, 'the user was still choosing');

    country.setDisabled(true);
    await tick(host);
    assert.ok(combobox.disabled, 'an element that renders its own input switches itself off');
    assert.notOk(combobox.open, 'and a panel left open over a form that is saving is not a panel');
  });

  it('focuses the first invalid field, including one that generates its own input', async () => {
    const host = mount(`
      <form>
        <ui-field name="name" label="Name"><input id="name-input" /></ui-field>
        <ui-field name="country" label="Country"><ui-combobox id="country-input"></ui-combobox></ui-field>
      </form>
    `);
    const fields = [...host.querySelectorAll('ui-field')];
    const form = group({ name: field('Aurora', [required()]), country: field('', [required()]) });
    /** @type {UiField} */ (present(fields[0])).field = form.fields.name;
    /** @type {UiField} */ (present(fields[1])).field = form.fields.country;
    await tick(host);

    assert.ok(focusInvalidField(host, form));
    assert.equal(
      document.activeElement?.getAttribute('data-ui-part'),
      'combobox-input',
      'focus() on the host would have done nothing at all',
    );

    // A server error outranks a client rule: it is about a value the user was
    // just told was fine, and is the more surprising of the two.
    form.fields.name.serverError.value = 'taken';
    assert.ok(focusInvalidField(host, form));
    assert.equal(document.activeElement?.id, 'name-input');
  });
});
