import { assert, mount, present, settled, unmountAll } from '../../../lib/test/harness.js';
import { preferenceKey } from '@core/preferences/persistence.js';
import { useStandardText } from '../standard-text.js';
import '@components/data/ui-dynamic-filter.js';

/** @import { FilterRule, FilterState, UiDynamicFilter } from '@components/data/ui-dynamic-filter.js' */
/** @import { UiCombobox } from '@components/inputs/ui-combobox.js' */

const STATE_KEY = preferenceKey('ui-dynamic-filter', 'test-filter');

/** The persisted envelope, as text: enough to assert on without an `any` in sight. */
function storedJson() {
  return present(localStorage.getItem(STATE_KEY));
}

/** @param {Element} element */
async function ready(element) {
  await settled(element);
  const combobox = element.querySelector('ui-combobox');
  if (combobox !== null) await settled(combobox);
  await settled(element);
}

/** @returns {UiDynamicFilter} */
function filterFixture() {
  return mount('<ui-dynamic-filter name="test-filter"></ui-dynamic-filter>');
}

/** @type {FilterRule[]} */
const RULES = [
  { ref: 'active', type: 'boolean', value: true, label: 'Only active', group: 'Status' },
  { ref: 'state', type: 'option', value: 'pending', label: 'Pending', group: 'Status' },
  {
    ref: 'team',
    type: 'children',
    group: 'Team',
    children: [
      { value: 'core', label: 'Core' },
      { value: 'web', label: 'Web' },
    ],
  },
  {
    ref: 'search',
    type: 'free',
    condition: (row, value) =>
      String(/** @type {{ name: string }} */ (row).name)
        .toLocaleLowerCase()
        .includes(String(value).toLocaleLowerCase()),
  },
];

/** @param {UiDynamicFilter} filter @returns {UiCombobox} */
function combobox(filter) {
  return /** @type {UiCombobox} */ (present(filter.querySelector('ui-combobox')));
}

/** @param {UiDynamicFilter} filter */
function optionElements(filter) {
  return [...filter.querySelectorAll('[data-ui-part="combobox-option"]')];
}

/** @param {Element} element */
function pointerDown(element) {
  element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
}

/** @param {UiDynamicFilter} filter */
async function openPanel(filter) {
  pointerDown(present(filter.querySelector('[data-ui-part="combobox-control"]')));
  await ready(filter);
}

/** @param {UiDynamicFilter} filter @param {string} label */
async function choose(filter, label) {
  const option = optionElements(filter).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  pointerDown(present(option, `no option labelled ${label}`));
  await ready(filter);
}

/** @param {UiDynamicFilter} filter @param {string} text */
async function type(filter, text) {
  const input = /** @type {HTMLInputElement} */ (
    present(filter.querySelector('[data-ui-part="combobox-input"]'))
  );
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await ready(filter);
}

describe('ui-dynamic-filter', () => {
  beforeEach(() => {
    localStorage.removeItem(STATE_KEY);
    useStandardText();
  });
  afterEach(() => {
    unmountAll();
    localStorage.removeItem(STATE_KEY);
  });

  it('turns rules into grouped options and emits table-ready state', async () => {
    const filter = filterFixture();
    filter.rules = RULES;
    await ready(filter);
    await openPanel(filter);

    assert.sameArray(
      [...filter.querySelectorAll('[data-ui-part="combobox-group-label"]')].map((group) =>
        group.textContent?.trim(),
      ),
      ['Status', 'Team'],
    );
    assert.equal(optionElements(filter).length, 4);

    /** @type {FilterState[] | undefined} */
    let detail;
    filter.addEventListener('filter-change', (event) => {
      detail = /** @type {CustomEvent<FilterState[]>} */ (event).detail;
    });

    await choose(filter, 'Core');

    const states = present(detail);
    assert.equal(states.length, 1);
    assert.equal(present(states[0]).ref, 'team');
    assert.equal(present(states[0]).key, 'team', 'key mirrors ref so ui-table can consume it');
    assert.equal(present(states[0]).value, 'core');
    assert.equal(present(states[0]).predicate, undefined, 'no condition means column matching');
  });

  it('holds one value per ref and releases the siblings when the chip goes', async () => {
    const filter = filterFixture();
    filter.rules = RULES;
    await ready(filter);
    await openPanel(filter);
    await choose(filter, 'Core');

    const web = present(optionElements(filter)[3]);
    assert.equal(web.textContent?.trim(), 'Web');
    assert.equal(web.getAttribute('aria-disabled'), 'true');
    assert.equal(
      present(optionElements(filter)[0]).getAttribute('aria-disabled'),
      'false',
      'another ref stays selectable',
    );

    present(filter.querySelector('[data-ui-part="combobox-chip-remove"]')).dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    await ready(filter);

    assert.equal(filter.selection.length, 0);
    assert.equal(present(optionElements(filter)[3]).getAttribute('aria-disabled'), 'false');
  });

  it('allows several values for a ref marked multiple', async () => {
    const filter = filterFixture();
    filter.rules = RULES.map((rule) => (rule.ref === 'team' ? { ...rule, multiple: true } : rule));
    await ready(filter);
    await openPanel(filter);

    await choose(filter, 'Core');
    await choose(filter, 'Web');

    assert.equal(filter.selection.length, 2);
    assert.sameArray(
      filter.states.map((state) => state.value),
      ['core', 'web'],
    );
  });

  it('carries a free-text entry with its predicate and drops it on removal', async () => {
    const filter = filterFixture();
    filter.rules = RULES;
    await ready(filter);

    await type(filter, 'milan');
    pointerDown(present(filter.querySelector('[data-ui-part="combobox-add-tag"]')));
    await ready(filter);

    const state = present(filter.states[0]);
    assert.equal(state.ref, 'search');
    assert.equal(state.value, 'milan');
    assert.ok(present(state.predicate)({ name: 'Milano srl' }, 'milan', 0));
    assert.notOk(present(state.predicate)({ name: 'Roma spa' }, 'milan', 0));

    // One free entry at a time: the add-tag row is gone while one is held.
    await type(filter, 'turin');
    assert.equal(filter.querySelector('[data-ui-part="combobox-add-tag"]'), null);

    present(filter.querySelector('[data-ui-part="combobox-chip-remove"]')).dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    await ready(filter);

    assert.equal(filter.states.length, 0);
    assert.notOk(
      filter.options.some((option) => option.type === 'free'),
      'a removed free entry is not offered back as a suggestion',
    );
  });

  it('prefixes a chip with its group', async () => {
    const filter = filterFixture();
    filter.rules = RULES;
    await ready(filter);
    await openPanel(filter);
    await choose(filter, 'Core');

    assert.equal(
      present(filter.querySelector('[data-ui-part="combobox-chip-label"]')).textContent?.trim(),
      'Team: Core',
    );
  });

  it('restores the selection from storage and forgets values whose option is gone', async () => {
    const first = filterFixture();
    first.rules = RULES;
    await ready(first);
    await openPanel(first);
    await choose(first, 'Core');
    await choose(first, 'Pending');
    unmountAll();

    const second = filterFixture();
    second.rules = RULES;
    await ready(second);

    assert.sameArray(
      second.states.map((state) => state.value),
      ['core', 'pending'],
      'chips come back in the order they were chosen',
    );
    await openPanel(second);
    assert.equal(present(optionElements(second)[3]).getAttribute('aria-disabled'), 'true');

    unmountAll();

    // The team rule disappears; its persisted value must not survive as an
    // invisible filter.
    const third = filterFixture();
    third.rules = RULES.filter((rule) => rule.ref !== 'team');
    await ready(third);

    assert.sameArray(
      third.states.map((state) => state.value),
      ['pending'],
    );
    assert.includes(storedJson(), '"ref":"state"');
    assert.notOk(
      storedJson().includes('"ref":"team"'),
      'the stale entry is rewritten out of storage',
    );
  });

  it('clears everything at once', async () => {
    const filter = filterFixture();
    filter.rules = RULES;
    await ready(filter);
    await openPanel(filter);
    await choose(filter, 'Core');
    await choose(filter, 'Pending');

    present(filter.querySelector('[data-ui-part="combobox-clear"]')).dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    await ready(filter);

    assert.equal(filter.states.length, 0);
    assert.notOk(
      filter.options.some((option) => option.disabled === true),
      'every option is selectable again',
    );
    assert.includes(storedJson(), '"state":[]');
  });

  it('stays stateless when persistence is off', async () => {
    const filter = filterFixture();
    filter.persist = false;
    filter.rules = RULES;
    await ready(filter);
    await openPanel(filter);
    await choose(filter, 'Core');

    assert.equal(filter.states.length, 1);
    assert.equal(localStorage.getItem(STATE_KEY), null);
  });

  it('reloads persisted state into a live element', async () => {
    const filter = filterFixture();
    filter.rules = RULES;
    await ready(filter);
    await openPanel(filter);
    await choose(filter, 'Core');
    assert.equal(filter.states.length, 1);

    localStorage.setItem(
      STATE_KEY,
      JSON.stringify({
        schemaVersion: 1,
        savedAt: 0,
        state: [{ ref: 'state', type: 'option', value: 'pending' }],
      }),
    );
    filter.reload();
    await ready(filter);

    assert.sameArray(
      filter.states.map((state) => state.value),
      ['pending'],
    );
    assert.equal(combobox(filter).value.length, 1);
  });
});
