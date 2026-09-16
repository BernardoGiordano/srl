import { fieldArray } from '@core/forms/array.js';
import { field } from '@core/forms/field.js';
import { group } from '@core/forms/group.js';
import { email, maxRows, minRows, ordered, required, sameAs, uniqueBy } from '@core/forms/validators.js';
import { assert } from '../harness.js';

/**
 * Rules about a set of values. Two members that must be in order, a list that must hold
 * at least one row, two rows that may not collide.
 *
 * What these tests pin is where the answer goes. A container's code belongs to the
 * container, so `invalidPath` says `''` and the element that shows it is `ui-form-error`
 * rather than any field. It never outranks a member that is itself invalid.
 * `source/components/test/inputs/form-error.test.js` is the one that mounts.
 */
describe('a rule over a group', () => {
  const period = () =>
    group(
      {
        start: field('', [required()]),
        end: field('', [required()]),
      },
      [ordered('start', 'end')],
    );

  it('belongs to the group, not to any member', () => {
    const form = period();
    form.fields.start.setValue('2026-03-07');
    form.fields.end.setValue('2026-03-03');

    assert.notOk(form.valid.value);
    assert.equal(form.error.value, 'outOfOrder');
    assert.equal(form.invalidPath.value, '', 'the empty path is the group itself');
    assert.equal(form.fields.end.error.value, '', 'the member broke no rule of its own');
  });

  it('loses to a member that is invalid on its own', () => {
    const form = period();
    form.fields.start.setValue('2026-03-07');

    // Both are true, since `end` is empty and the pair is not in order. A specific
    // control is a better place to send someone than a sentence about the form.
    assert.equal(form.invalidPath.value, 'end');
  });

  it('stays quiet until every member has been visited, or the form is submitted', () => {
    const form = period();
    form.fields.start.setValue('2026-03-07');
    form.fields.end.setValue('2026-03-03');

    assert.equal(form.visibleError.value, '', 'nothing has been left yet');

    form.fields.start.touch();
    assert.equal(form.visibleError.value, '', 'one of the two is not every one');

    form.fields.end.touch();
    assert.equal(form.visibleError.value, 'outOfOrder');
  });

  it('appears on submit without waiting to be visited', () => {
    const form = period();
    form.fields.start.setValue('2026-03-07');
    form.fields.end.setValue('2026-03-03');

    assert.notOk(form.markSubmitted());
    assert.equal(form.visibleError.value, 'outOfOrder');
  });

  it('does not count a member nobody may edit', () => {
    const form = period();
    form.fields.start.setValue('2026-03-07');
    form.fields.end.setValue('2026-03-03');
    form.fields.end.setDisabled(true);
    form.fields.start.touch();

    // Waiting for a switched-off control to be visited would keep the message off
    // the screen for good.
    assert.ok(form.touched.value);
    assert.equal(form.visibleError.value, 'outOfOrder');
  });

  it('says nothing while the whole group is switched off', () => {
    const form = period();
    form.fields.start.setValue('2026-03-07');
    form.fields.end.setValue('2026-03-03');
    form.setDisabled(true);

    assert.ok(form.valid.value, 'there is no control to correct');
    assert.equal(form.error.value, '');
    assert.equal(form.invalidPath.value, null);
  });

  it('is addressed by its name from the form above it', () => {
    const form = group({
      name: field('', [required()]),
      period: group({ start: field(''), end: field('') }, [ordered('start', 'end')]),
    });
    form.fields.name.setValue('Acme');
    form.fields.period.fields.start.setValue('2026-03-07');
    form.fields.period.fields.end.setValue('2026-03-03');

    assert.equal(form.invalidPath.value, 'period');
    assert.notOk(form.valid.value);
  });

  it('leaves a per-control answer to applyErrors, which is where a 422 lands too', () => {
    const form = group({
      password: field('', [required()]),
      confirmation: field('', [required()]),
    });

    assert.sameArray(form.applyErrors({ confirmation: 'mismatched' }), []);
    assert.equal(form.fields.confirmation.error.value, 'mismatched');

    // Cleared by the edit that answers it, which a group-level code is not.
    form.fields.confirmation.setValue('secret');
    assert.equal(form.fields.confirmation.error.value, '');
  });
});

describe('a rule over a field array', () => {
  /**
   * @param {readonly import('@core/forms/types.js').Validator<{ email: string }[]>[]} validators
   */
  const contacts = (validators) =>
    fieldArray(() => group({ email: field('', [required(), email()]) }), [], validators);

  it('reports too few rows, and only after a submit while the list is empty', () => {
    const rows = contacts([minRows(1)]);

    assert.notOk(rows.valid.value);
    assert.notOk(rows.touched.value, 'a list nobody has filled in has not been anywhere');
    assert.equal(rows.visibleError.value, '', 'three words of red on a fresh form is the greeting to avoid');

    assert.notOk(rows.markSubmitted());
    assert.equal(rows.visibleError.value, 'tooFewRows');
  });

  it('reports too many rows', () => {
    const rows = contacts([maxRows(1)]);
    rows.push({ email: 'one@example.com' });
    assert.ok(rows.valid.value);

    rows.push({ email: 'two@example.com' });
    assert.notOk(rows.valid.value);
    assert.equal(rows.error.value, 'tooManyRows');
    assert.equal(rows.invalidPath.value, '', 'the list is what repeats, not a row');
  });

  it('finds two rows that collide, and ignores the ones still empty', () => {
    const rows = contacts([uniqueBy('email')]);
    rows.push();
    rows.push();
    assert.equal(rows.error.value, '', 'two rows just added are not duplicates of each other');

    rows.push({ email: 'same@example.com' });
    rows.push({ email: 'same@example.com' });
    assert.equal(rows.error.value, 'duplicated');
  });

  it('loses to a row that is invalid on its own', () => {
    const rows = contacts([minRows(3)]);
    rows.push({ email: 'not-an-address' });

    assert.equal(rows.invalidPath.value, '0.email');
  });
});

describe('the container validators themselves', () => {
  it('lets a half-filled pair alone, and a pair on the same day', () => {
    assert.equal(ordered('a', 'b')({ a: '', b: '2026-01-01' }), '');
    assert.equal(ordered('a', 'b')({ a: '2026-01-01', b: '' }), '');
    assert.equal(ordered('a', 'b')({ a: '2026-01-01', b: '2026-01-01' }), '', 'one day is a period');
    assert.equal(ordered('a', 'b')({ a: '2026-01-02', b: '2026-01-01' }), 'outOfOrder');
  });

  it('compares two members only once both are filled in', () => {
    assert.equal(sameAs('a', 'b')({ a: 'secret', b: '' }), '', 'the empty one says required itself');
    assert.equal(sameAs('a', 'b')({ a: 'secret', b: 'secret' }), '');
    assert.equal(sameAs('a', 'b')({ a: 'secret', b: 'other' }), 'mismatched');
  });

  it('counts rows', () => {
    assert.equal(minRows(2)([{}]), 'tooFewRows');
    assert.equal(minRows(2)([{}, {}]), '');
    assert.equal(maxRows(1)([{}, {}]), 'tooManyRows');
  });
});
