import { fieldArray } from '@core/forms/array.js';
import { field } from '@core/forms/field.js';
import { group } from '@core/forms/group.js';
import { minRows, ordered, required } from '@core/forms/validators.js';
import { assert, mount, present, settled, unmountAll } from '../../../lib/test/harness.js';
import { useStandardText } from '../standard-text.js';
import { focusInvalidField } from '@components/inputs/ui-field.js';
import '@components/inputs/ui-form-error.js';

/** @import { UiFormError } from '@components/inputs/ui-form-error.js' */

/**
 * `ui-form-error`, which is the answer to the question that kept container
 * validators out of the library: a rule about a set of values has a code and no
 * control to sit under. ADR-0102.
 */
describe('ui-form-error', () => {
  beforeEach(() => {
    useStandardText();
  });

  afterEach(() => {
    unmountAll();
  });

  it('renders nothing until the node has something to show', async () => {
    const host = /** @type {UiFormError} */ (mount('<ui-form-error error-class="err"></ui-form-error>'));
    const form = group({ start: field(''), end: field('') }, [ordered('start', 'end')]);
    host.node = form;
    await settled(host);

    assert.equal(host.querySelector('p'), null, 'no rule has failed yet');

    form.fields.start.setValue('2026-03-07');
    form.fields.end.setValue('2026-03-03');
    await settled(host);
    assert.equal(host.querySelector('p'), null, 'the timing rule has not let it through yet');

    form.markSubmitted();
    await settled(host);
    const paragraph = /** @type {HTMLElement} */ (present(host.querySelector('p')));
    assert.equal(paragraph.textContent?.trim(), 'Out of order', 'the code resolves through ui.field.*');
    assert.equal(paragraph.getAttribute('role'), 'alert');
    assert.equal(paragraph.className, 'err');
  });

  it("prefers the application's own message for a code", async () => {
    const host = /** @type {UiFormError} */ (mount('<ui-form-error></ui-form-error>'));
    const rows = fieldArray(() => group({ name: field('', [required()]) }), [], [minRows(1)]);
    host.node = rows;
    host.messages = { tooFewRows: 'Add at least one contact' };
    rows.markSubmitted();
    await settled(host);

    assert.equal(present(host.querySelector('p')).textContent?.trim(), 'Add at least one contact');
  });

  it('takes focus from a refused submit when the rule belongs to no control', async () => {
    const host = mount(`
      <div>
        <ui-field name="name"><input id="customer-name" /></ui-field>
        <ui-form-error></ui-form-error>
      </div>
    `);
    const form = group(
      { start: field('', [required()]), end: field('', [required()]) },
      [ordered('start', 'end')],
    );
    const error = /** @type {UiFormError} */ (present(host.querySelector('ui-form-error')));
    error.node = form;
    form.fields.start.setValue('2026-03-07');
    form.fields.end.setValue('2026-03-03');
    await settled(error);

    // `firstInvalid` says `''` for this and for a valid form alike, which is why
    // `focusInvalidField` reads `invalidPath` instead.
    assert.equal(form.firstInvalid.value, '');
    assert.equal(form.invalidPath.value, '');

    assert.ok(focusInvalidField(host, form));
    assert.equal(document.activeElement, error, 'the message is where a refused submit lands');
  });

  it('is not a stop on the way through the form', async () => {
    const host = /** @type {UiFormError} */ (mount('<ui-form-error></ui-form-error>'));
    await settled(host);
    assert.equal(host.tabIndex, -1);
  });

  it('leaves a valid form with nowhere to send anyone', async () => {
    const host = mount('<div><ui-form-error></ui-form-error></div>');
    const form = group({ start: field(''), end: field('') }, [ordered('start', 'end')]);
    /** @type {UiFormError} */ (present(host.querySelector('ui-form-error'))).node = form;
    await settled(host);

    assert.notOk(focusInvalidField(host, form));
  });
});
