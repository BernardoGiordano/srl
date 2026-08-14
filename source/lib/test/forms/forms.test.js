import { effect } from '@core/foundation/reactive.js';
import { fieldArray } from '@core/forms/array.js';
import { field } from '@core/forms/field.js';
import { group } from '@core/forms/group.js';
import {
  email,
  isEmpty,
  maxLength,
  minLength,
  notAfter,
  notBefore,
  oneOf,
  pattern,
  required,
  today,
} from '@core/forms/validators.js';
import { assert } from '../harness.js';

/**
 * The form primitives, with no DOM in sight.
 *
 * That is the point of them being in `core`: validity, the timing rule for showing
 * an error, dirtiness and the server's answers are decisions about state, and a
 * suite that had to mount an element to test them would be testing `ui-field` as
 * well. `source/components/test/inputs/field.test.js` is the one that mounts.
 */
describe('form field', () => {
  it('reports the first failing rule, in declaration order', () => {
    const name = field('', [required(), minLength(2), maxLength(4)]);

    // Empty says "required", not "too short": a field reporting both would show
    // two sentences for one mistake, and the wrong one first.
    assert.equal(name.error.value, 'required');

    name.setValue('a');
    assert.equal(name.error.value, 'tooShort');

    name.setValue('abcde');
    assert.equal(name.error.value, 'tooLong');

    name.setValue('abc');
    assert.equal(name.error.value, '');
    assert.ok(name.valid.value);
  });

  it('keeps an error invisible until the field is left or the form is submitted', () => {
    const city = field('', [required()]);

    assert.equal(city.error.value, 'required', 'the rule fails from the start');
    assert.equal(city.visibleError.value, '', 'and says nothing until the user has been there');

    city.touch();
    assert.equal(city.visibleError.value, 'required');

    const other = field('', [required()]);
    other.submitted.value = true;
    assert.equal(other.visibleError.value, 'required', 'a submit makes every error visible at once');
  });

  it('shows a server error immediately and drops it on the next edit', () => {
    const name = field('Aurora', [required()]);

    name.serverError.value = 'taken';
    assert.equal(name.visibleError.value, 'taken', 'a 422 answers a submit that already happened');
    assert.ok(name.valid.value, 'and does not make the field invalid');

    name.setValue('Caelum');
    assert.equal(name.visibleError.value, '', 'the answer was about the value that was sent');
  });

  it('outranks a validator with the server, because the server is the authority', () => {
    const name = field('', [required()]);
    name.serverError.value = 'taken';
    assert.equal(name.error.value, 'taken');
  });

  it('tracks dirtiness against a baseline that reset moves', () => {
    const city = field('Milano');
    assert.notOk(city.dirty.value);

    city.setValue('Torino');
    assert.ok(city.dirty.value);

    city.setValue('Milano');
    assert.notOk(city.dirty.value, 'typing back to the original is not a change');

    city.setValue('Genova');
    city.reset(city.value.value);
    assert.notOk(city.dirty.value, 'reset adopts the value as the new unchanged');
  });

  it('compares array values element-wise', () => {
    // `Object.is` on two arrays holding the same codes says they differ, which
    // would make a multi-select dirty the moment it loaded.
    const tags = field(['a', 'b']);
    tags.setValue(['a', 'b']);
    assert.notOk(tags.dirty.value);

    tags.setValue(['b', 'a']);
    assert.ok(tags.dirty.value, 'order counts: reordering a selection is an edit');
  });

  it('stops answering for a disabled field, without dropping its value', () => {
    const revenue = field('120', [required()]);
    revenue.setValue('');
    revenue.touch();
    assert.equal(revenue.visibleError.value, 'required');

    revenue.setDisabled(true);
    assert.ok(revenue.valid.value, 'a rule the user cannot reach must not refuse a submit');
    assert.equal(revenue.error.value, '');
    assert.equal(revenue.visibleError.value, '');
    assert.equal(revenue.value.value, '', 'the value is still there, and still what a save sends');
    assert.ok(revenue.dirty.value, 'and still an unsaved change');

    revenue.setDisabled(false);
    assert.equal(revenue.visibleError.value, 'required', 'the rule comes back with the control');
  });

  it('keeps a server error through a disable rather than clearing it', () => {
    // The 422 is about a value that is still in the form and still going to be
    // sent. Hidden while there is no control to correct, back when there is.
    const name = field('Aurora', [required()]);
    name.serverError.value = 'taken';

    name.setDisabled(true);
    assert.equal(name.visibleError.value, '');

    name.setDisabled(false);
    assert.equal(name.visibleError.value, 'taken');
  });

  it('does not switch a field back on when it is reset', () => {
    const owner = field('Ada');
    owner.setDisabled(true);

    owner.reset('Grace');
    assert.ok(owner.disabled.value, 'who may edit this is the screen\'s rule, not user state');
    assert.equal(owner.value.value, 'Grace', 'and a disabled field can still be filled in code');
  });

  it('is a signal all the way down', () => {
    const name = field('', [required()]);
    /** @type {string[]} */
    const seen = [];
    const stop = effect(() => {
      seen.push(name.visibleError.value);
    });

    name.touch();
    name.setValue('Ada');
    stop();

    assert.sameArray(seen, ['', 'required', ''], 'each change notified exactly once');
  });
});

describe('form group', () => {
  const build = () =>
    group({
      name: field('', [required()]),
      email: field('', [required(), email()]),
      city: field('Milano'),
    });

  it('aggregates validity and dirtiness', () => {
    const form = build();
    assert.notOk(form.valid.value);
    assert.notOk(form.dirty.value);

    form.fields.name.setValue('Aurora');
    assert.ok(form.dirty.value);
    assert.notOk(form.valid.value, 'email is still empty');

    form.fields.email.setValue('hello@aurora.example');
    assert.ok(form.valid.value);
  });

  it('names the first invalid field in declaration order', () => {
    const form = build();
    assert.equal(form.firstInvalid.value, 'name');

    form.fields.name.setValue('Aurora');
    assert.equal(form.firstInvalid.value, 'email');

    form.fields.email.setValue('hello@aurora.example');
    assert.equal(form.firstInvalid.value, '');
  });

  it('reports whether a submit may proceed, and makes every error visible', () => {
    const form = build();

    assert.notOk(form.markSubmitted(), 'an invalid form refuses');
    assert.equal(form.fields.email.visibleError.value, 'required', 'including fields never touched');

    form.fields.name.setValue('Aurora');
    form.fields.email.setValue('hello@aurora.example');
    assert.ok(form.markSubmitted());
  });

  it('applies per-field server errors and returns the names it did not recognise', () => {
    const form = build();
    const unmatched = form.applyErrors({ name: 'taken', vatNumber: 'malformed' });

    assert.equal(form.fields.name.serverError.value, 'taken');
    assert.sameArray(unmatched, ['vatNumber'], 'a field this form does not have is reported, not swallowed');
    assert.equal(form.firstServerError, 'name');

    form.clearServerErrors();
    assert.equal(form.firstServerError, '');
  });

  it('collects values by name', () => {
    const form = build();
    form.fields.name.setValue('Aurora');

    const values = form.values;
    assert.sameArray(Object.keys(values), ['name', 'email', 'city'], 'declaration order');
    assert.equal(values.name, 'Aurora');
    assert.equal(values.email, '');
    assert.equal(values.city, 'Milano');
  });

  it('disables every field at once, and lets a submit through while it does', () => {
    const form = build();
    assert.notOk(form.valid.value, 'two fields are empty and required');

    form.setDisabled(true);
    assert.ok(form.fields.name.disabled.value);
    assert.ok(form.valid.value, 'a form nobody can edit cannot be refused for what is in it');
    assert.equal(form.firstInvalid.value, '');
    assert.sameArray(Object.keys(form.values), ['name', 'email', 'city'], 'every value is still sent');

    form.setDisabled(false);
    assert.notOk(form.valid.value);
  });

  it('leaves a field disabled on its own alone when the form is enabled', () => {
    // A form disabled while it saves must not, on the way back, switch on the one
    // field a domain rule had switched off all along.
    const form = build();
    form.fields.city.setDisabled(true);

    form.setDisabled(true);
    form.setDisabled(false);

    assert.ok(form.fields.city.disabled.value);
    assert.notOk(form.fields.name.disabled.value);
  });

  it('does not name a disabled field as the one to focus', () => {
    const form = build();
    form.applyErrors({ name: 'taken' });
    assert.equal(form.firstServerError, 'name');

    form.fields.name.setDisabled(true);
    assert.equal(form.firstServerError, '', 'focusing a control the user cannot type in looks like nothing happening');
  });

  it('patches without moving the baseline, and resets with it', () => {
    const form = build();

    form.patch({ city: 'Torino' });
    assert.ok(form.dirty.value, 'a patched value is an edit the user may still undo');

    form.reset({ name: 'Aurora', email: 'hello@aurora.example', city: 'Torino' });
    assert.notOk(form.dirty.value, 'what the server returned is the new unchanged');
    assert.notOk(form.submitted.value);
    assert.equal(form.fields.name.visibleError.value, '');
  });
});

describe('nested groups', () => {
  const build = () =>
    group({
      name: field('', [required()]),
      address: group({
        city: field('', [required()]),
        zip: field('20121'),
      }),
    });

  it('nests the value shape rather than flattening it', () => {
    const form = build();
    form.fields.address.fields.city.setValue('Milano');

    assert.equal(
      JSON.stringify(form.values),
      JSON.stringify({ name: '', address: { city: 'Milano', zip: '20121' } }),
      'a group contributes an object, in declaration order',
    );
  });

  it('names an invalid control by its path', () => {
    const form = build();
    assert.equal(form.firstInvalid.value, 'name');

    form.fields.name.setValue('Aurora');
    assert.equal(form.firstInvalid.value, 'address.city', 'the same string a <ui-field name> carries');

    form.fields.address.fields.city.setValue('Milano');
    assert.equal(form.firstInvalid.value, '');
  });

  it('aggregates validity and dirtiness through the nesting', () => {
    const form = build();
    assert.notOk(form.dirty.value);

    form.fields.address.fields.zip.setValue('20122');
    assert.ok(form.dirty.value, 'a change two levels down is still an unsaved change');
    assert.ok(form.fields.address.dirty.value);
  });

  it('resolves a server error at a path, and reports a code it cannot place', () => {
    const form = build();
    const unmatched = form.applyErrors({ 'address.zip': 'notAllowed', address: 'malformed' });

    assert.equal(form.fields.address.fields.zip.serverError.value, 'notAllowed');
    assert.sameArray(unmatched, ['address'], 'a code naming a container is reported, not shown under a row');
    assert.equal(form.firstServerError, 'address.zip');

    form.clearServerErrors();
    assert.equal(form.firstServerError, '');
  });

  it('does not resolve a path onto the prototype', () => {
    // `fields.constructor` exists on every object. A server sending it must not
    // reach anything, or `applyErrors` becomes a way to call into the runtime.
    const form = build();
    assert.sameArray(form.applyErrors({ constructor: 'taken' }), ['constructor']);
  });

  it('carries disabled down every level', () => {
    const form = build();
    form.setDisabled(true);
    assert.ok(form.fields.address.disabled.value, 'the nested group');
    assert.ok(form.fields.address.fields.city.disabled.value, 'and the field inside it');
    assert.ok(form.valid.value, 'a form nobody can edit cannot be refused for what is in it');

    form.setDisabled(false);
    assert.notOk(form.fields.address.fields.city.disabled.value);
  });

  it('patches and resets to a partial depth', () => {
    const form = build();
    form.patch({ address: { city: 'Torino' } });
    assert.equal(form.fields.address.fields.city.value.value, 'Torino');
    assert.equal(form.fields.address.fields.zip.value.value, '20121', 'what was left out is left alone');
    assert.ok(form.dirty.value);

    form.reset({ address: { city: 'Torino' } });
    assert.notOk(form.dirty.value, 'the baseline moved with it');
  });
});

describe('field arrays', () => {
  const contact = () =>
    group({
      name: field('', [required()]),
      email: field('', [required(), email()]),
    });

  const build = () => group({ name: field('Aurora'), contacts: fieldArray(contact) });

  /** @param {{ name: string, email: string }} values */
  const filled = (values) => values;

  it('starts at the rows it was given, and they are not unsaved changes', () => {
    const form = group({
      contacts: fieldArray(contact, [filled({ name: 'Ada', email: 'ada@example.com' })]),
    });

    assert.equal(form.fields.contacts.length.value, 1);
    assert.notOk(form.dirty.value, 'a form that opens on one contact is not a form with one edit in it');
    assert.equal(
      JSON.stringify(form.values),
      JSON.stringify({ contacts: [{ name: 'Ada', email: 'ada@example.com' }] }),
    );
  });

  it('counts adding and removing a row as a change, not only editing one', () => {
    const form = build();
    const contacts = form.fields.contacts;

    contacts.push();
    assert.ok(form.dirty.value, 'an empty row the user asked for is an unsaved change');

    contacts.removeAt(0);
    assert.notOk(form.dirty.value, 'and taking it away again undoes it');
  });

  it('does not call a removed row replaced by a new one clean', () => {
    // The case a length comparison gets wrong. Remove the one contact, add
    // another, and there is one row either way — but not the same one, and a
    // guard that let the user walk away here would lose the deletion.
    const form = group({
      contacts: fieldArray(contact, [filled({ name: 'Ada', email: 'ada@example.com' })]),
    });
    const contacts = form.fields.contacts;

    contacts.removeAt(0);
    contacts.push();
    assert.equal(contacts.length.value, 1, 'the same number of rows');
    assert.ok(form.dirty.value, 'and not the same rows: keys are never reused');
  });

  it('refuses a removal that names no row', () => {
    const form = build();
    form.fields.contacts.push();

    assert.notOk(form.fields.contacts.removeAt(1), 'a second click must not take the row below');
    assert.notOk(form.fields.contacts.removeAt(-1));
    assert.equal(form.fields.contacts.length.value, 1);
  });

  it('puts the rows back where reset finds them', () => {
    const form = group({
      contacts: fieldArray(contact, [
        filled({ name: 'Ada', email: 'ada@example.com' }),
        filled({ name: 'Grace', email: 'grace@example.com' }),
      ]),
    });
    const contacts = form.fields.contacts;

    contacts.removeAt(0);
    contacts.push(filled({ name: 'Alan', email: 'alan@example.com' }));
    form.reset();

    assert.equal(contacts.length.value, 2);
    assert.equal(
      JSON.stringify(contacts.values),
      JSON.stringify([
        { name: 'Ada', email: 'ada@example.com' },
        { name: 'Grace', email: 'grace@example.com' },
      ]),
      'the row that was deleted is back, at the value it had',
    );
    assert.notOk(form.dirty.value);
  });

  it('resizes to what the server returned, and calls that the new unchanged', () => {
    const form = build();
    form.fields.contacts.push();

    form.reset({ contacts: [filled({ name: 'Ada', email: 'ada@example.com' })] });
    assert.equal(form.fields.contacts.length.value, 1);
    assert.notOk(form.dirty.value);

    form.reset({ contacts: [] });
    assert.equal(form.fields.contacts.length.value, 0, 'a save that removed every contact leaves none');
    assert.notOk(form.dirty.value);
  });

  it('treats the length as part of a patched value', () => {
    const form = build();
    form.patch({ contacts: [filled({ name: 'Ada', email: 'ada@example.com' })] });

    assert.equal(form.fields.contacts.length.value, 1, 'a patch that supplies a row adds it');
    assert.ok(form.dirty.value, 'a patched value is an edit the user may still undo');

    const contacts = form.fields.contacts;
    contacts.fill(contacts.values);
    assert.equal(contacts.length.value, 1, 'filling an array with its own values changes nothing');
  });

  it('addresses a row field by index, in both directions', () => {
    const form = build();
    form.fields.contacts.push();
    form.fields.contacts.push(filled({ name: 'Grace', email: 'not-an-address' }));

    assert.equal(form.firstInvalid.value, 'contacts.0.name', 'first row, first rule, in declaration order');

    form.fields.contacts.rows.value[0]?.control.patch(filled({ name: 'Ada', email: 'ada@example.com' }));
    assert.equal(form.firstInvalid.value, 'contacts.1.email');

    const unmatched = form.applyErrors({ 'contacts.1.email': 'taken', 'contacts.9.email': 'taken' });
    assert.equal(form.fields.contacts.rows.value[1]?.control.fields.email.serverError.value, 'taken');
    assert.sameArray(unmatched, ['contacts.9.email'], 'a row the form does not have is reported');
    assert.equal(form.firstServerError, 'contacts.1.email');
  });

  it('will not read an index it cannot confirm it understood', () => {
    const form = build();
    form.fields.contacts.push();

    assert.sameArray(
      form.applyErrors({ 'contacts.01.name': 'required', 'contacts..name': 'required' }),
      ['contacts.01.name', 'contacts..name'],
      'Number() would take both, and neither says which row it means',
    );
  });

  it('reaches rows built after the form was switched off', () => {
    const form = build();
    form.setDisabled(true);

    const row = form.fields.contacts.push();
    assert.ok(row.disabled.value, 'the row inherits the array, which inherits the form');
    assert.ok(row.fields.name.disabled.value);

    form.setDisabled(false);
    assert.notOk(row.fields.name.disabled.value);
  });

  it('leaves a row added after a submit quiet until the next one', () => {
    const form = build();
    form.fields.contacts.push();
    assert.notOk(form.markSubmitted());

    const first = form.fields.contacts.rows.value[0]?.control.fields.name;
    assert.equal(first?.visibleError.value, 'required', 'the rows that were there say why');

    const added = form.fields.contacts.push();
    assert.equal(
      added.fields.name.visibleError.value,
      '',
      'a row the user just asked for does not open with two errors in it',
    );

    form.markSubmitted();
    assert.equal(added.fields.name.visibleError.value, 'required', 'the next submit marks it like the rest');
  });

  it('keeps a row key stable so a keyed repeat is not rebuilt', () => {
    const form = group({
      contacts: fieldArray(contact, [
        filled({ name: 'Ada', email: 'ada@example.com' }),
        filled({ name: 'Grace', email: 'grace@example.com' }),
      ]),
    });
    const contacts = form.fields.contacts;
    const before = contacts.rows.value.map((row) => row.key);

    contacts.reset([filled({ name: 'Ada', email: 'ada@example.com' }), filled({ name: 'Hedy', email: 'hedy@example.com' })]);

    assert.sameArray(
      contacts.rows.value.map((row) => row.key),
      before,
      'a reset that changes a value must not look to lit like two new rows',
    );
    assert.sameArray(
      contacts.rows.value.map((row) => row.index),
      [0, 1],
      'the index follows position, which is why it is not the key',
    );
  });

  it('is a signal all the way down, through the array', () => {
    const form = build();
    /** @type {boolean[]} */
    const seen = [];
    const stop = effect(() => {
      seen.push(form.valid.value);
    });

    const row = form.fields.contacts.push();
    row.fields.name.setValue('Ada');
    row.fields.email.setValue('ada@example.com');
    stop();

    assert.sameArray(seen, [true, false, true], 'adding an empty row invalidates the form it was added to');
  });
});

describe('validators', () => {
  it('treats an empty array as absent, so required works on a multi-select', () => {
    const check = required();
    assert.equal(check([]), 'required');
    assert.equal(check(['a']), '');
    assert.equal(check('   '), 'required');
    assert.equal(check(null), 'required');
  });

  it('lets an empty value past every rule except required', () => {
    // Emptiness is `required`'s question. A rule that answered it too would
    // report "malformed" for a field nobody has filled in yet.
    assert.equal(email()(''), '');
    assert.equal(minLength(3)(''), '');
    assert.equal(oneOf(['a'])(''), '');
    assert.equal(notAfter()(''), '');
  });

  it('does not let a stateful regex remember where it stopped', () => {
    // A /g expression advances lastIndex between calls, so the same value would
    // pass and fail alternately.
    const check = pattern(/ab/gu);
    assert.equal(check('abab'), '');
    assert.equal(check('abab'), '', 'the second call must answer the same as the first');
  });

  it('bounds a date against today in local time', () => {
    assert.equal(notAfter()(today()), '', 'today is not the future');
    assert.equal(notAfter()('2999-01-01'), 'future');
    assert.equal(notAfter()('not-a-date'), 'malformed');
    assert.equal(notBefore('2020-01-01')('2019-12-31'), 'past');
    assert.equal(notBefore('2020-01-01')('2020-01-01'), '');
  });

  it('answers emptiness for every shape a control holds', () => {
    assert.ok(isEmpty(''));
    assert.ok(isEmpty([]));
    assert.ok(isEmpty(undefined));
    assert.notOk(isEmpty('a'));
    assert.notOk(isEmpty(['a']));
    assert.notOk(isEmpty(false), 'a boolean control that is off still has a value');
  });
});
