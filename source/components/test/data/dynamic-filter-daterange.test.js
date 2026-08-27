import { assert, mount, present, settled, unmountAll } from '../../../lib/test/harness.js';
import { preferenceKey } from '@core/preferences/persistence.js';
import { DATE_RANGE_SEPARATOR, readRange, shiftDay } from '@components/inputs/ui-date-range.js';
import { useStandardText } from '../standard-text.js';
import '@components/data/ui-dynamic-filter.js';

/** @import { FilterRule, UiDynamicFilter } from '@components/data/ui-dynamic-filter.js' */

const STATE_KEY = preferenceKey('ui-dynamic-filter', 'range-filter');

/** March 3rd to 7th inclusive, which is `03..08` once the end is exclusive. */
const MARCH_WEEK = `2026-03-03${DATE_RANGE_SEPARATOR}2026-03-08`;

/** @returns {UiDynamicFilter} */
function filterFixture() {
  return mount('<ui-dynamic-filter name="range-filter" locale="en-GB"></ui-dynamic-filter>');
}

/** @type {FilterRule[]} */
const RULES = [
  {
    ref: 'created',
    type: 'daterange',
    group: 'Created',
    label: 'Custom range',
    presets: [
      { label: 'That week', value: MARCH_WEEK },
      { label: 'That day', value: `2026-03-03${DATE_RANGE_SEPARATOR}2026-03-04` },
    ],
  },
];

/** @param {UiDynamicFilter} filter */
function optionLabels(filter) {
  return [...filter.querySelectorAll('[data-ui-part="combobox-option"]')].map((option) =>
    option.textContent?.trim(),
  );
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

/** @param {UiDynamicFilter} filter @param {string} startsWith */
async function choose(filter, startsWith) {
  const option = [...filter.querySelectorAll('[data-ui-part="combobox-option"]')].find((candidate) =>
    (candidate.textContent?.trim() ?? '').startsWith(startsWith),
  );
  pointerDown(present(option, `no option starting with ${startsWith}`));
  await settled(filter);
}

/** @param {UiDynamicFilter} filter @param {string} part @param {string} value */
async function fill(filter, part, value) {
  const input = /** @type {HTMLInputElement} */ (present(filter.querySelector(part)));
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await settled(filter);
}

/** @param {UiDynamicFilter} filter @param {string} part */
async function click(filter, part) {
  present(filter.querySelector(part)).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await settled(filter);
}

describe('date range helpers', () => {
  it('moves a day without falling into the UTC trap', () => {
    assert.equal(shiftDay('2026-03-01', -1), '2026-02-28');
    assert.equal(shiftDay('2026-12-31', 1), '2027-01-01');
    assert.equal(shiftDay('2024-02-28', 1), '2024-02-29');
  });

  it('reads a stored range back as the inclusive days a person would name', () => {
    assert.equal(present(readRange(MARCH_WEEK)).since, '2026-03-03');
    assert.equal(present(readRange(MARCH_WEEK)).until, '2026-03-07');
    assert.notOk(present(readRange(MARCH_WEEK)).singleDay);

    const oneDay = present(readRange(`2026-03-03${DATE_RANGE_SEPARATOR}2026-03-04`));
    assert.equal(oneDay.since, '2026-03-03');
    assert.ok(oneDay.singleDay, 'a one-day interval reads as one day, not as a two-day range');

    assert.equal(readRange('nonsense'), undefined);
    assert.equal(readRange(undefined), undefined);
  });
});

describe('ui-dynamic-filter daterange rules', () => {
  beforeEach(() => {
    localStorage.removeItem(STATE_KEY);
    useStandardText();
  });
  afterEach(() => {
    unmountAll();
    localStorage.removeItem(STATE_KEY);
  });

  it('offers presets plus one custom row, and labels each with its days', async () => {
    const filter = filterFixture();
    filter.rules = RULES;
    await settled(filter);
    await openPanel(filter);

    assert.sameArray(optionLabels(filter), [
      'That week from 03/03/2026 to 07/03/2026',
      'That day 03/03/2026',
      'Custom range',
    ]);
  });

  it('applies a preset without opening the editor', async () => {
    const filter = filterFixture();
    filter.rules = RULES;
    await settled(filter);
    await openPanel(filter);
    await choose(filter, 'That week');

    assert.sameArray(
      filter.states.map((state) => state.value),
      [MARCH_WEEK],
    );
    assert.notOk(
      filter.querySelector('[data-ui-part="date-range"]'),
      'a preset is a ready answer, not a question',
    );
    const applied = present(filter.states[0]);
    assert.equal(applied.match, 'range', 'the rule type says how the value is compared');
    assert.equal(
      applied.predicate,
      undefined,
      'a range needs no hand-written condition from the screen',
    );
    assert.equal(
      present(filter.querySelector('[data-ui-part="combobox-chip-label"]')).textContent?.trim(),
      'Created: That week from 03/03/2026 to 07/03/2026',
    );
  });

  it('asks for a custom range and stores the end exclusively', async () => {
    const filter = filterFixture();
    filter.rules = RULES;
    await settled(filter);
    await openPanel(filter);
    await choose(filter, 'Custom range');

    assert.ok(
      filter.querySelector('[data-ui-part="date-range"]'),
      'the editor opens under the row that asked for it',
    );
    assert.equal(filter.states.length, 0, 'nothing is applied while the editor is open');

    await fill(filter, '[data-ui-part="date-range-since"]', '2026-04-10');
    await fill(filter, '[data-ui-part="date-range-until"]', '2026-04-15');
    await click(filter, '[data-ui-part="date-range-confirm"]');

    assert.sameArray(
      filter.states.map((state) => state.value),
      [`2026-04-10${DATE_RANGE_SEPARATOR}2026-04-16`],
      'the user picked the 15th inclusive; storage holds the 16th exclusive',
    );
    assert.includes(present(localStorage.getItem(STATE_KEY)), '2026-04-16');
    assert.equal(
      present(filter.querySelector('[data-ui-part="combobox-chip-label"]')).textContent?.trim(),
      'Created: Custom range from 10/04/2026 to 15/04/2026',
    );
  });

  it('collapses a hand-picked range onto the preset that already covers it', async () => {
    const filter = filterFixture();
    filter.rules = RULES;
    await settled(filter);
    await openPanel(filter);
    await choose(filter, 'Custom range');

    await fill(filter, '[data-ui-part="date-range-since"]', '2026-03-03');
    await fill(filter, '[data-ui-part="date-range-until"]', '2026-03-07');
    await click(filter, '[data-ui-part="date-range-confirm"]');

    assert.sameArray(
      filter.states.map((state) => state.value),
      [MARCH_WEEK],
    );
    assert.equal(
      present(filter.querySelector('[data-ui-part="combobox-chip-label"]')).textContent?.trim(),
      'Created: That week from 03/03/2026 to 07/03/2026',
      'one range, one row: the preset, not a duplicate custom entry',
    );
    await openPanel(filter);
    assert.includes(optionLabels(filter).join('|'), '|Custom range');
  });

  it('leaves nothing behind when the editor is dismissed', async () => {
    const filter = filterFixture();
    filter.rules = RULES;
    await settled(filter);
    await openPanel(filter);
    await choose(filter, 'Custom range');
    await click(filter, '[data-ui-part="date-range-cancel"]');

    assert.equal(filter.states.length, 0);
    assert.equal(filter.selection.length, 0, 'the row was never a selection to unpick');
    assert.notOk(filter.querySelector('[data-ui-part="date-range"]'));
  });

  it('refuses an end before the start', async () => {
    const filter = filterFixture();
    filter.rules = RULES;
    await settled(filter);
    await openPanel(filter);
    await choose(filter, 'Custom range');

    await fill(filter, '[data-ui-part="date-range-since"]', '2026-03-07');
    await fill(filter, '[data-ui-part="date-range-until"]', '2026-03-03');
    await click(filter, '[data-ui-part="date-range-confirm"]');

    assert.equal(
      present(filter.querySelector('[data-ui-part="date-range-error"]')).textContent?.trim(),
      'End is before start',
    );
    assert.ok(filter.querySelector('[data-ui-part="date-range"]'), 'and stays open');
    assert.equal(filter.states.length, 0);
  });

  it('resets the custom row when its chip is removed, but not a preset', async () => {
    const filter = filterFixture();
    filter.rules = RULES;
    await settled(filter);
    await openPanel(filter);
    await choose(filter, 'Custom range');
    await fill(filter, '[data-ui-part="date-range-since"]', '2026-04-10');
    await fill(filter, '[data-ui-part="date-range-until"]', '2026-04-15');
    await click(filter, '[data-ui-part="date-range-confirm"]');

    await openPanel(filter);
    assert.includes(optionLabels(filter).join('|'), 'Custom range from 10/04/2026');

    await click(filter, '[data-ui-part="combobox-chip-remove"]');
    await openPanel(filter);

    assert.sameArray(optionLabels(filter), [
      'That week from 03/03/2026 to 07/03/2026',
      'That day 03/03/2026',
      'Custom range',
    ]);
  });

  it('restores a custom range and tells it apart from a preset', async () => {
    const custom = `2026-05-01${DATE_RANGE_SEPARATOR}2026-05-05`;
    localStorage.setItem(
      STATE_KEY,
      JSON.stringify({
        schemaVersion: 1,
        savedAt: 0,
        state: [{ ref: 'created', type: 'daterange', value: custom }],
      }),
    );

    const filter = filterFixture();
    filter.rules = RULES;
    await settled(filter);
    await openPanel(filter);

    assert.sameArray(
      filter.states.map((state) => state.value),
      [custom],
    );
    assert.includes(
      optionLabels(filter).join('|'),
      'Custom range from 01/05/2026 to 04/05/2026',
      'the custom row carries the restored range, not one of the presets',
    );
  });

  it('starts on the default preset, and only writes it once the user acts', async () => {
    const filter = filterFixture();
    filter.rules = [
      {
        ref: 'created',
        type: 'daterange',
        group: 'Created',
        label: 'Custom range',
        presets: [
          { label: 'That week', value: MARCH_WEEK, default: true },
          { label: 'That day', value: `2026-03-03${DATE_RANGE_SEPARATOR}2026-03-04` },
        ],
      },
    ];
    await settled(filter);
    await settled(filter);

    assert.sameArray(
      filter.states.map((state) => state.value),
      [MARCH_WEEK],
    );
    assert.equal(
      localStorage.getItem(STATE_KEY),
      null,
      'a default recomputes on every visit, so it is not persisted until touched',
    );

    await click(filter, '[data-ui-part="combobox-chip-remove"]');
    assert.includes(present(localStorage.getItem(STATE_KEY)), '"state":[]');
  });

  it('reports the ready state with the default already applied', async () => {
    const filter = filterFixture();
    /** @type {unknown} */
    let detail;
    filter.addEventListener('filter-ready', (event) => {
      detail = /** @type {CustomEvent} */ (event).detail;
    });
    filter.rules = [
      {
        ref: 'created',
        type: 'daterange',
        group: 'Created',
        label: 'Custom range',
        presets: [{ label: 'That week', value: MARCH_WEEK, default: true }],
      },
    ];
    await settled(filter);
    await settled(filter);

    assert.equal(/** @type {unknown[]} */ (detail).length, 1);
  });
});
