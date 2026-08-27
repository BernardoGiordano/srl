import { assert, mount, present, settled, unmountAll } from '../../../lib/test/harness.js';
import { useStandardText } from '../standard-text.js';
import '@components/inputs/ui-combobox.js';

/** @import { ComboboxOption, UiCombobox } from '@components/inputs/ui-combobox.js' */

/** @param {Element} element */
async function ready(element) {
  await settled(element);
  await settled(element);
}

/** @returns {UiCombobox} */
function comboboxFixture() {
  return mount('<ui-combobox multiple placeholder="Search"></ui-combobox>');
}

/** @type {ComboboxOption[]} */
const OPTIONS = [
  { value: 'ada', label: 'Ada Lovelace', group: 'People' },
  { value: 'grace', label: 'Grace Hopper', group: 'People' },
  { value: 'core', label: 'Core', group: 'Teams' },
  { value: 'web', label: 'Web', group: 'Teams', disabled: true },
];

/** @param {UiCombobox} combobox */
function optionElements(combobox) {
  return [...combobox.querySelectorAll('[data-ui-part="combobox-option"]')];
}

/** @param {UiCombobox} combobox @param {string} text */
async function type(combobox, text) {
  const input = /** @type {HTMLInputElement} */ (
    present(combobox.querySelector('[data-ui-part="combobox-input"]'))
  );
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await ready(combobox);
}

/** @param {Element} element */
function pointerDown(element) {
  element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
}

/** @param {UiCombobox} combobox @param {string} key */
async function press(combobox, key) {
  present(combobox.querySelector('[data-ui-part="combobox-input"]')).dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
  );
  await ready(combobox);
}

describe('ui-combobox', () => {
  // "No results", "Clear all", "Remove" and the spinner's name are standard text
  // now; only the add-tag prefix is still a property, because it names the data.
  beforeEach(() => useStandardText());

  afterEach(() => {
    unmountAll();
  });

  it('groups options and selects one into a chip', async () => {
    const combobox = comboboxFixture();
    combobox.options = OPTIONS;
    await ready(combobox);

    assert.notOk(combobox.open, 'starts closed');

    pointerDown(present(combobox.querySelector('[data-ui-part="combobox-control"]')));
    await ready(combobox);

    assert.ok(combobox.open);
    const groups = [...combobox.querySelectorAll('[data-ui-part="combobox-group-label"]')];
    assert.sameArray(
      groups.map((group) => group.textContent?.trim()),
      ['People', 'Teams'],
    );
    assert.equal(optionElements(combobox).length, 4);

    /** @type {unknown} */
    let added;
    combobox.addEventListener('option-add', (event) => {
      added = /** @type {CustomEvent} */ (event).detail;
    });
    pointerDown(present(optionElements(combobox)[1]));
    await ready(combobox);

    assert.equal(added, OPTIONS[1]);
    assert.sameArray([...combobox.value], [OPTIONS[1]]);
    assert.equal(
      present(combobox.querySelector('[data-ui-part="combobox-chip-label"]')).textContent?.trim(),
      'Grace Hopper',
    );
    assert.equal(present(optionElements(combobox)[1]).getAttribute('aria-selected'), 'true');
  });

  it('filters by term, keeps it after adding, and reports every search', async () => {
    const combobox = comboboxFixture();
    combobox.options = OPTIONS;
    await ready(combobox);

    /** @type {string[]} */
    const terms = [];
    combobox.addEventListener('search-change', (event) => {
      terms.push(/** @type {CustomEvent<string>} */ (event).detail);
    });

    await type(combobox, 'gra');
    assert.sameArray(terms, ['gra']);
    assert.equal(optionElements(combobox).length, 1);

    pointerDown(present(optionElements(combobox)[0]));
    await ready(combobox);

    // clearSearchOnAdd is off, so a second result from the same search is reachable.
    assert.equal(combobox.searchTerm, 'gra');
    assert.ok(combobox.open);
    assert.sameArray(terms, ['gra']);
  });

  it('never selects a disabled option, by pointer or by keyboard', async () => {
    const combobox = comboboxFixture();
    combobox.options = OPTIONS;
    await ready(combobox);

    pointerDown(present(combobox.querySelector('[data-ui-part="combobox-control"]')));
    await ready(combobox);

    const disabled = present(optionElements(combobox)[3]);
    assert.equal(disabled.getAttribute('aria-disabled'), 'true');
    pointerDown(disabled);
    await ready(combobox);
    assert.equal(combobox.value.length, 0);

    // Four options, the last disabled: arrowing down four times wraps past it.
    for (let step = 0; step < 4; step += 1) await press(combobox, 'ArrowDown');
    await press(combobox, 'Enter');

    assert.equal(combobox.value.length, 1);
    assert.equal(present(combobox.value[0]).value, 'ada');
  });

  it('moves the active option with the keyboard and advertises it to screen readers', async () => {
    const combobox = comboboxFixture();
    combobox.options = OPTIONS;
    await ready(combobox);

    await press(combobox, 'ArrowDown');
    const input = present(combobox.querySelector('[data-ui-part="combobox-input"]'));
    const first = present(optionElements(combobox)[0]);
    assert.equal(input.getAttribute('aria-expanded'), 'true');
    assert.equal(input.getAttribute('aria-activedescendant'), first.id);
    assert.equal(
      input.getAttribute('aria-controls'),
      present(combobox.querySelector('[data-ui-part="combobox-panel"]')).id,
    );

    await press(combobox, 'ArrowDown');
    assert.equal(
      input.getAttribute('aria-activedescendant'),
      present(optionElements(combobox)[1]).id,
    );

    await press(combobox, 'Escape');
    assert.notOk(combobox.open);
    assert.equal(input.getAttribute('aria-activedescendant'), null);
    assert.equal(input.getAttribute('aria-expanded'), 'false');
    // The panel is gone, so the id it had is gone: a closed combobox that still
    // controls something names an element no screen reader can reach. ADR-0078.
    assert.equal(input.getAttribute('aria-controls'), null);
  });

  it('adds a tag only when the term names nothing listed', async () => {
    const combobox = comboboxFixture();
    combobox.options = OPTIONS;
    combobox.addTagLabel = 'Add';
    combobox.addTag = (term) => {
      /** @type {ComboboxOption} */
      const option = { value: term, label: term, group: 'Free text' };
      combobox.options = [...combobox.options, option];
      return option;
    };
    await ready(combobox);

    await type(combobox, 'Ada Lovelace');
    assert.equal(combobox.querySelector('[data-ui-part="combobox-add-tag"]'), null);

    await type(combobox, 'milan');
    const addTag = present(combobox.querySelector('[data-ui-part="combobox-add-tag"]'));
    assert.equal(addTag.textContent?.trim(), 'Add "milan"');

    pointerDown(addTag);
    await ready(combobox);

    assert.equal(combobox.value.length, 1);
    assert.equal(present(combobox.value[0]).value, 'milan');
  });

  it('removes the last chip on backspace and clears the whole selection', async () => {
    const combobox = comboboxFixture();
    combobox.options = OPTIONS;
    combobox.value = [present(OPTIONS[0]), present(OPTIONS[1])];
    await ready(combobox);

    /** @type {string[]} */
    const events = [];
    for (const name of ['option-remove', 'selection-clear', 'selection-change']) {
      combobox.addEventListener(name, () => events.push(name));
    }

    await press(combobox, 'Backspace');
    assert.sameArray([...combobox.value], [OPTIONS[0]]);
    assert.sameArray(events, ['option-remove', 'selection-change']);

    present(combobox.querySelector('[data-ui-part="combobox-clear"]')).dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    await ready(combobox);

    assert.equal(combobox.value.length, 0);
    assert.sameArray(events, [
      'option-remove',
      'selection-change',
      'selection-clear',
      'selection-change',
    ]);
  });

  it('holds one value in single mode and closes after choosing', async () => {
    const combobox = comboboxFixture();
    combobox.multiple = false;
    combobox.options = OPTIONS;
    await ready(combobox);

    pointerDown(present(combobox.querySelector('[data-ui-part="combobox-control"]')));
    await ready(combobox);
    pointerDown(present(optionElements(combobox)[0]));
    await ready(combobox);

    assert.notOk(combobox.open);
    assert.sameArray([...combobox.value], [OPTIONS[0]]);

    pointerDown(present(combobox.querySelector('[data-ui-part="combobox-control"]')));
    await ready(combobox);
    pointerDown(present(optionElements(combobox)[1]));
    await ready(combobox);

    assert.sameArray([...combobox.value], [OPTIONS[1]]);
  });

  /*
   * A chip is a removable one of several. One answer is not several, so it is the
   * input's text — what a `<select>` shows — and the clear button is the only way to
   * unset it rather than the second of two.
   */
  it('shows a single choice as text, not as a chip', async () => {
    const combobox = comboboxFixture();
    combobox.multiple = false;
    combobox.options = OPTIONS;
    combobox.value = [present(OPTIONS[1])];
    await ready(combobox);

    const input = /** @type {HTMLInputElement} */ (
      present(combobox.querySelector('[data-ui-part="combobox-input"]'))
    );
    assert.notOk(combobox.querySelector('[data-ui-part="combobox-chip"]'), 'no chip');
    assert.equal(input.value, 'Grace Hopper');
    assert.notOk(input.getAttribute('placeholder'), 'a filled control does not prompt');

    // Open, and the same box is the search field: the label would otherwise be
    // typed into and become half a term.
    pointerDown(present(combobox.querySelector('[data-ui-part="combobox-control"]')));
    await ready(combobox);
    assert.equal(input.value, '');
    assert.equal(input.getAttribute('placeholder'), 'Search');

    await type(combobox, 'ada');
    assert.equal(input.value, 'ada');

    // Closing drops the term, so the label comes back rather than a search nobody
    // applied.
    await press(combobox, 'Escape');
    assert.notOk(combobox.open);
    assert.equal(input.value, 'Grace Hopper');
  });

  it('renders consumer content for options and chips', async () => {
    const combobox = comboboxFixture();
    combobox.options = OPTIONS;
    combobox.optionRenderer = (option) => `» ${option.label}`;
    combobox.chipRenderer = (option) => `${String(option.group)}: ${option.label}`;
    combobox.value = [present(OPTIONS[0])];
    await ready(combobox);

    pointerDown(present(combobox.querySelector('[data-ui-part="combobox-control"]')));
    await ready(combobox);

    assert.equal(present(optionElements(combobox)[0]).textContent?.trim(), '» Ada Lovelace');
    assert.equal(
      present(combobox.querySelector('[data-ui-part="combobox-chip-label"]')).textContent?.trim(),
      'People: Ada Lovelace',
    );
  });

  it('shows the not-found message and closes on an outside pointer', async () => {
    const combobox = comboboxFixture();
    combobox.options = OPTIONS;
    await ready(combobox);

    await type(combobox, 'zzz');
    assert.equal(
      present(combobox.querySelector('[data-ui-part="combobox-empty"]')).textContent?.trim(),
      'No results',
    );

    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await ready(combobox);
    assert.notOk(combobox.open);
  });
});
