import { assert, mount, present, settled, unmountAll } from '../../../lib/test/harness.js';
import { configureClock, createManualClock } from '@core/foundation/clock.js';
import { preferenceKey } from '@core/preferences/persistence.js';
import { useStandardText } from '../standard-text.js';
import '@components/data/ui-dynamic-filter.js';

/** @import { ManualClock } from '@core/foundation/types.js' */
/** @import { FilterRule, SelectItem, UiDynamicFilter } from '@components/data/ui-dynamic-filter.js' */

const STATE_KEY = preferenceKey('ui-dynamic-filter', 'async-filter');

/**
 * The clock the typeahead debounce is scheduled on. This suite used to import the
 * element's debounce constant and sleep past it; draining the clock says the same
 * thing without the element having to publish a number. ADR-0079.
 *
 * @type {ManualClock}
 */
let clock;

/**
 * Rules hand back a promise. Returning a resolved one keeps the fixtures honest
 * about the contract without an `await` that would do nothing.
 *
 * @param {readonly SelectItem[]} items
 * @returns {Promise<readonly SelectItem[]>}
 */
function resolved(items) {
  return Promise.resolve(items);
}

/**
 * Let the debounced search happen, and wait for the results to render.
 *
 * `flush()` runs the debounce now rather than 320 milliseconds from now. The
 * settle afterwards covers both the rules' promises and the rebuild they cause:
 * the walk only stops once a pass finds no element it has not already waited for,
 * so the render the search schedules is inside it.
 */
async function searched(/** @type {Element} */ element) {
  clock.flush();
  await settled(element);
}

/** @returns {UiDynamicFilter} */
function filterFixture() {
  return mount(`
    <ui-dynamic-filter name="async-filter"></ui-dynamic-filter>
  `);
}

/** @param {UiDynamicFilter} filter */
function optionElements(filter) {
  return [...filter.querySelectorAll('[data-ui-part="combobox-option"]')];
}

/** @param {UiDynamicFilter} filter */
function optionLabels(filter) {
  return optionElements(filter).map((option) => option.textContent?.trim());
}

/** @param {Element} element */
function pointerDown(element) {
  element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
}

/** @param {UiDynamicFilter} filter */
async function openPanel(filter) {
  pointerDown(present(filter.querySelector('[data-ui-part="combobox-control"]')));
  await settled(filter);
}

/** @param {UiDynamicFilter} filter @param {string} text */
async function type(filter, text) {
  const input = /** @type {HTMLInputElement} */ (
    present(filter.querySelector('[data-ui-part="combobox-input"]'))
  );
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await settled(filter);
}

/** @param {UiDynamicFilter} filter @param {string} label */
async function choose(filter, label) {
  const option = optionElements(filter).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  pointerDown(present(option, `no option labelled ${label}`));
  await settled(filter);
}

/** @param {readonly { ref: string, type: string, value: unknown }[]} state */
function seedStorage(state) {
  localStorage.setItem(STATE_KEY, JSON.stringify({ schemaVersion: 1, savedAt: 0, state }));
}

describe('ui-dynamic-filter async rules', () => {
  beforeEach(() => {
    localStorage.removeItem(STATE_KEY);
    useStandardText();
    clock = createManualClock();
    configureClock({ clock });
  });
  afterEach(() => {
    unmountAll();
    configureClock();
    localStorage.removeItem(STATE_KEY);
  });

  it('loads an observer rule once, on connect', async () => {
    let calls = 0;
    const filter = filterFixture();
    /** @type {FilterRule[]} */
    const rules = [
      {
        ref: 'team',
        type: 'observer',
        group: 'Team',
        children: () => {
          calls += 1;
          return resolved([
            { value: 'core', label: 'Core' },
            { value: 'web', label: 'Web' },
          ]);
        },
      },
    ];
    filter.rules = rules;
    await settled(filter);
    await settled(filter);
    await openPanel(filter);

    assert.equal(calls, 1);
    assert.sameArray(optionLabels(filter), ['Core', 'Web']);
  });

  it('keeps a whole filter usable when one rule fails', async () => {
    const filter = filterFixture();
    /** @type {FilterRule[]} */
    const rules = [
      { ref: 'state', type: 'option', value: 'open', label: 'Open', group: 'Status' },
      {
        ref: 'team',
        type: 'observer',
        group: 'Team',
        children: () => Promise.reject(new Error('backend down')),
      },
    ];
    filter.rules = rules;
    await settled(filter);
    await settled(filter);
    await openPanel(filter);

    assert.sameArray(optionLabels(filter), ['Open']);
    assert.notOk(filter.loading);
  });

  it('defers a lazy rule until its row is clicked, then replaces it in place', async () => {
    let calls = 0;
    const filter = filterFixture();
    /** @type {FilterRule[]} */
    const rules = [
      {
        ref: 'city',
        type: 'lazy',
        group: 'City',
        label: 'Load cities',
        children: () => {
          calls += 1;
          return resolved([
            { value: 'mi', label: 'Milano' },
            { value: 'rm', label: 'Roma' },
          ]);
        },
      },
    ];
    filter.rules = rules;
    await settled(filter);
    await openPanel(filter);

    assert.equal(calls, 0, 'nothing is fetched before the row is clicked');
    assert.sameArray(optionLabels(filter), ['Load cities']);

    pointerDown(present(optionElements(filter)[0]));
    await settled(filter);
    await settled(filter);

    assert.equal(calls, 1);
    assert.sameArray(optionLabels(filter), ['Milano', 'Roma']);
    assert.equal(filter.states.length, 0, 'the placeholder never becomes a filter');
    assert.ok(
      filter.querySelector('[data-ui-part="combobox-panel"]'),
      'the panel stays open over the list it just loaded',
    );
  });

  it('reoffers a lazy row after a failed load', async () => {
    let attempt = 0;
    const filter = filterFixture();
    /** @type {FilterRule[]} */
    const rules = [
      {
        ref: 'city',
        type: 'lazy',
        group: 'City',
        label: 'Load cities',
        children: () => {
          attempt += 1;
          if (attempt === 1) return Promise.reject(new Error('backend down'));
          return resolved([{ value: 'mi', label: 'Milano' }]);
        },
      },
    ];
    filter.rules = rules;
    await settled(filter);
    await openPanel(filter);

    pointerDown(present(optionElements(filter)[0]));
    await settled(filter);
    await settled(filter);
    assert.sameArray(optionLabels(filter), ['Load cities'], 'the row survives the failure');

    pointerDown(present(optionElements(filter)[0]));
    await settled(filter);
    await settled(filter);

    assert.equal(attempt, 2);
    assert.sameArray(optionLabels(filter), ['Milano']);
  });

  it('loads a lazy rule up front when a persisted value needs it', async () => {
    seedStorage([{ ref: 'city', type: 'lazy', value: 'mi' }]);
    const filter = filterFixture();
    /** @type {FilterRule[]} */
    const rules = [
      {
        ref: 'city',
        type: 'lazy',
        group: 'City',
        label: 'Load cities',
        children: () =>
          resolved([
            { value: 'mi', label: 'Milano' },
            { value: 'rm', label: 'Roma' },
          ]),
      },
    ];
    filter.rules = rules;
    await settled(filter);
    await settled(filter);

    assert.sameArray(
      filter.states.map((state) => state.value),
      ['mi'],
    );
    assert.equal(
      present(filter.querySelector('[data-ui-part="combobox-chip-label"]')).textContent?.trim(),
      'City: Milano',
      'the restored chip shows a label, not a raw id',
    );
  });

  it('searches typeahead rules after a debounce and shows only the current results', async () => {
    /** @type {string[]} */
    const terms = [];
    const filter = filterFixture();
    /** @type {FilterRule[]} */
    const rules = [
      {
        ref: 'comune',
        type: 'typeahead',
        group: 'Comune',
        label: 'Type to search',
        children: (term) => {
          terms.push(term);
          return resolved(
            term.startsWith('mil')
              ? [{ value: 'mi', label: 'Milano' }]
              : [{ value: 'rm', label: 'Roma' }],
          );
        },
      },
    ];
    filter.rules = rules;
    await settled(filter);
    await openPanel(filter);

    assert.sameArray(optionLabels(filter), ['Type to search']);

    await type(filter, 'm');
    await searched(filter);
    assert.sameArray(terms, [], 'a term below minChars never reaches the server');
    assert.sameArray(optionLabels(filter), ['Type to search']);

    await type(filter, 'mil');
    await searched(filter);

    assert.sameArray(terms, ['mil']);
    assert.sameArray(optionLabels(filter), ['Milano'], 'the hint gives way to results');

    await type(filter, 'rom');
    await searched(filter);

    assert.sameArray(terms, ['mil', 'rom']);
    assert.sameArray(optionLabels(filter), ['Roma'], 'the previous search leaves nothing behind');
  });

  it('collapses a burst of keystrokes into one search', async () => {
    let calls = 0;
    const filter = filterFixture();
    /** @type {FilterRule[]} */
    const rules = [
      {
        ref: 'comune',
        type: 'typeahead',
        group: 'Comune',
        label: 'Type to search',
        children: () => {
          calls += 1;
          return resolved([{ value: 'mi', label: 'Milano' }]);
        },
      },
    ];
    filter.rules = rules;
    await settled(filter);
    await openPanel(filter);

    for (const term of ['mi', 'mil', 'mila', 'milan']) await type(filter, term);
    await searched(filter);

    assert.equal(calls, 1);
  });

  it('keeps a typeahead result even when its label does not contain the term', async () => {
    const filter = filterFixture();
    /** @type {FilterRule[]} */
    const rules = [
      {
        ref: 'comune',
        type: 'typeahead',
        group: 'Comune',
        label: 'Type to search',
        // Matched by postcode on the server: the label has no '20121' in it.
        children: () => resolved([{ value: 'mi', label: 'Milano' }]),
      },
    ];
    filter.rules = rules;
    await settled(filter);
    await openPanel(filter);
    await type(filter, '20121');
    await searched(filter);

    assert.sameArray(optionLabels(filter), ['Milano']);
  });

  it('resolves labels for persisted typeahead values and drops results on close', async () => {
    seedStorage([{ ref: 'comune', type: 'typeahead', value: 'mi' }]);
    /** @type {unknown[][]} */
    const asked = [];
    const filter = filterFixture();
    /** @type {FilterRule[]} */
    const rules = [
      {
        ref: 'comune',
        type: 'typeahead',
        group: 'Comune',
        label: 'Type to search',
        children: () => resolved([{ value: 'rm', label: 'Roma' }]),
        resolve: (values) => {
          asked.push([...values]);
          return resolved([{ value: 'mi', label: 'Milano' }]);
        },
      },
    ];
    filter.rules = rules;
    await settled(filter);
    await settled(filter);

    assert.sameArray(present(asked[0]), ['mi']);
    assert.equal(
      present(filter.querySelector('[data-ui-part="combobox-chip-label"]')).textContent?.trim(),
      'Comune: Milano',
    );

    await openPanel(filter);
    await type(filter, 'rom');
    await searched(filter);
    assert.includes(optionLabels(filter).join('|'), 'Roma');

    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await settled(filter);
    await openPanel(filter);

    assert.sameArray(
      optionLabels(filter),
      ['Type to search'],
      'a reopened panel is not showing the last search',
    );
    assert.sameArray(
      filter.states.map((state) => state.value),
      ['mi'],
      'and the chip is still there',
    );
  });

  it('selects a typeahead result and persists it', async () => {
    const filter = filterFixture();
    /** @type {FilterRule[]} */
    const rules = [
      {
        ref: 'comune',
        type: 'typeahead',
        group: 'Comune',
        label: 'Type to search',
        minChars: 3,
        children: () =>
          resolved([
            { value: 'mi', label: 'Milano' },
            { value: 'mo', label: 'Modena' },
          ]),
      },
    ];
    filter.rules = rules;
    await settled(filter);
    await openPanel(filter);
    await type(filter, 'mo');
    await searched(filter);
    assert.sameArray(optionLabels(filter), ['Type to search'], 'minChars is per rule');

    await type(filter, 'mod');
    await searched(filter);
    await choose(filter, 'Modena');

    assert.sameArray(
      filter.states.map((state) => state.value),
      ['mo'],
    );
    assert.includes(present(localStorage.getItem(STATE_KEY)), '"value":"mo"');
  });
  it('locks the siblings of every restored value, not only the ones picked by hand', async () => {
    seedStorage([
      { ref: 'team', type: 'observer', value: 'core' },
      { ref: 'city', type: 'lazy', value: 'mi' },
    ]);
    const filter = filterFixture();
    /** @type {FilterRule[]} */
    const rules = [
      {
        ref: 'team',
        type: 'observer',
        group: 'Team',
        children: () =>
          resolved([
            { value: 'core', label: 'Core' },
            { value: 'web', label: 'Web' },
          ]),
      },
      {
        ref: 'city',
        type: 'lazy',
        group: 'City',
        label: 'Load cities',
        children: () =>
          resolved([
            { value: 'mi', label: 'Milano' },
            { value: 'rm', label: 'Roma' },
          ]),
      },
    ];
    filter.rules = rules;
    await settled(filter);
    await settled(filter);
    await openPanel(filter);

    const state = optionElements(filter).map(
      (option) => `${String(option.textContent?.trim())}:${String(option.getAttribute('aria-disabled'))}`,
    );
    assert.sameArray(
      state,
      ['Core:false', 'Web:true', 'Milano:false', 'Roma:true'],
      'a ref holds one value, and a restored value locks its siblings exactly as a click does',
    );

    // The bug this covers: the last rebuild after the initial loads handed the
    // combobox a fresh, all-enabled list, so a second team was selectable.
    await choose(filter, 'Web');
    assert.sameArray(
      filter.states.map((entry) => entry.value),
      ['core', 'mi'],
      'the locked row refuses the click',
    );
  });

  it('resolves a persisted typeahead value by searching for it when no resolve is given', async () => {
    seedStorage([{ ref: 'comune', type: 'typeahead', value: 'Milano' }]);
    /** @type {string[]} */
    const terms = [];
    const filter = filterFixture();
    /** @type {FilterRule[]} */
    const rules = [
      {
        ref: 'comune',
        type: 'typeahead',
        group: 'Comune',
        label: 'Type to search',
        children: (term) => {
          terms.push(term);
          return resolved([
            { value: 'Milano', label: 'Milano' },
            { value: 'Milanesi', label: 'Milanesi' },
          ]);
        },
      },
    ];
    filter.rules = rules;
    await settled(filter);
    await settled(filter);

    assert.sameArray(terms, ['Milano'], 'the persisted value is the search term');
    assert.equal(
      present(filter.querySelector('[data-ui-part="combobox-chip-label"]')).textContent?.trim(),
      'Comune: Milano',
      'and only the result that is the value becomes the chip',
    );
    assert.sameArray(
      filter.states.map((entry) => entry.value),
      ['Milano'],
    );

    await openPanel(filter);
    assert.sameArray(
      optionLabels(filter),
      ['Type to search'],
      'the search that named the chip is not left in the panel',
    );
  });
});
