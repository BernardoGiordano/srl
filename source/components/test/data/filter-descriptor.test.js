import { assert } from '../../../lib/test/harness.js';
import {
  ANY_COLUMN,
  RANGE_SEPARATOR,
  compareValue,
  matchForRuleType,
  matchesRow,
  normalizeText,
  readPath,
} from '@components/data/filter-descriptor.js';

/**
 * The point of this file is that there is no fixture in it: no element, no mount,
 * no render pass. What "filtered" means is a plain function over a row, and these
 * are the cases the two components used to agree on only by coincidence.
 */

/** @type {readonly import('@components/data/filter-descriptor.js').FilterColumn[]} */
const COLUMNS = [
  { key: 'name' },
  { key: 'team' },
  { key: 'hired' },
  { key: 'meta.office' },
  { key: 'tags' },
  { key: 'salary', filterValue: (_row, _index, value) => `EUR ${String(value)}` },
];

const ROWS = [
  { name: 'Giulia', team: 'Sales', hired: '2021-03-15', meta: { office: 'Milano' }, tags: ['lead', 'crm'], salary: 41000 },
  { name: 'Marco', team: 'Pre-Sales', hired: '2024-02-05', meta: { office: 'Roma' }, tags: ['demo'], salary: 38000 },
];

/**
 * @param {import('@components/data/filter-descriptor.js').FilterDescriptor} descriptor
 * @returns {string[]}
 */
function names(descriptor) {
  return ROWS.filter((row, index) => matchesRow(row, index, descriptor, COLUMNS)).map(
    (row) => row.name,
  );
}

describe('filter descriptor', () => {
  describe('match modes', () => {
    it('separates Sales from Pre-Sales, which contains cannot', () => {
      assert.sameArray(names({ key: 'team', value: 'Sales', match: 'equals' }), ['Giulia']);
      assert.sameArray(names({ key: 'team', value: 'Sales', match: 'contains' }), [
        'Giulia',
        'Marco',
      ]);
    });

    it('defaults to contains, so a typed fragment still finds a row', () => {
      assert.sameArray(names({ key: 'name', value: 'giul' }), ['Giulia']);
    });

    it('matches any declared column under ANY_COLUMN, including nested and derived ones', () => {
      assert.sameArray(names({ key: ANY_COLUMN, value: 'milano' }), ['Giulia']);
      assert.sameArray(names({ key: ANY_COLUMN, value: 'crm' }), ['Giulia'], 'array cell');
      assert.sameArray(names({ key: ANY_COLUMN, value: 'EUR 38000' }), ['Marco'], 'filterValue');
      assert.sameArray(names({ value: 'roma' }), ['Marco'], 'no key means any column');
    });

    it('matches a range against the column named by the key', () => {
      const range = `2024-01-01${RANGE_SEPARATOR}2025-01-01`;
      assert.sameArray(names({ key: 'hired', value: range, match: 'range' }), ['Marco']);
    });

    it('excludes a row with no value in the ranged column rather than keeping it', () => {
      const range = `2024-01-01${RANGE_SEPARATOR}2025-01-01`;
      assert.notOk(matchesRow({ name: 'Nobody' }, 0, { key: 'hired', value: range, match: 'range' }, COLUMNS));
    });

    it('treats the upper bound as exclusive, which is how a stored range is written', () => {
      const upToTheFifth = `2024-02-01${RANGE_SEPARATOR}2024-02-05`;
      const throughTheFifth = `2024-02-01${RANGE_SEPARATOR}2024-02-06`;
      assert.sameArray(names({ key: 'hired', value: upToTheFifth, match: 'range' }), []);
      assert.sameArray(names({ key: 'hired', value: throughTheFifth, match: 'range' }), ['Marco']);
    });

    it('reads a Date cell as its day, so the last day of a range is not lost to its time', () => {
      const range = `2024-02-01${RANGE_SEPARATOR}2024-02-06`;
      const row = { hired: new Date('2024-02-05T18:30:00Z') };
      assert.ok(matchesRow(row, 0, { key: 'hired', value: range, match: 'range' }, [{ key: 'hired' }]));
    });
  });

  describe('what each rule type means', () => {
    it('makes a listed choice an identity and free text a substring', () => {
      assert.equal(matchForRuleType('children'), 'equals');
      assert.equal(matchForRuleType('option'), 'equals');
      assert.equal(matchForRuleType('boolean'), 'equals');
      assert.equal(matchForRuleType('date'), 'equals');
      assert.equal(matchForRuleType('observer'), 'equals');
      assert.equal(matchForRuleType('lazy'), 'equals');
      assert.equal(matchForRuleType('typeahead'), 'equals');
      assert.equal(matchForRuleType('free'), 'contains');
    });

    it('makes a daterange a range, so the rule needs no hand-written predicate', () => {
      assert.equal(matchForRuleType('daterange'), 'range');
    });

    it('falls back to contains for a type it has never heard of', () => {
      assert.equal(matchForRuleType('something-new'), 'contains');
    });
  });

  describe('what does not filter', () => {
    it('keeps every row for an unset value', () => {
      for (const value of [undefined, null, '']) {
        assert.sameArray(names({ key: 'team', value }), ['Giulia', 'Marco'], `value ${String(value)}`);
      }
    });

    it('keeps every row for a filter that is not an object', () => {
      const notADescriptor = /** @type {import('@components/data/filter-descriptor.js').FilterDescriptor} */ (
        /** @type {unknown} */ (null)
      );
      assert.ok(matchesRow(ROWS[0], 0, notADescriptor, COLUMNS));
    });
  });

  describe('a predicate wins', () => {
    it('is used instead of the match mode, and receives the row and index', () => {
      /** @type {number[]} */
      const seen = [];
      const descriptor = {
        key: 'team',
        value: 'ignored',
        match: /** @type {const} */ ('equals'),
        predicate: (/** @type {unknown} */ row, /** @type {unknown} */ value, /** @type {number} */ index) => {
          seen.push(index);
          return value === 'ignored' && /** @type {{ name: string }} */ (row).name === 'Marco';
        },
      };
      assert.sameArray(names(descriptor), ['Marco']);
      assert.sameArray(seen, [0, 1]);
    });
  });

  describe('the pieces on their own', () => {
    it('reads a dotted path, and the row itself for an empty one', () => {
      assert.equal(readPath({ meta: { office: 'Milano' } }, 'meta.office'), 'Milano');
      assert.equal(readPath({ meta: null }, 'meta.office'), undefined, 'stops at a null hop');
      assert.equal(readPath('row', ''), 'row');
    });

    it('normalizes only values that have a text form', () => {
      assert.equal(normalizeText('Milano'), 'milano');
      assert.equal(normalizeText(41000), '41000');
      assert.equal(normalizeText(true), 'true');
      assert.equal(normalizeText(null), '');
      assert.equal(normalizeText({ office: 'Milano' }), '', 'no [object Object] to match against');
    });

    it('compares an equal non-string by identity rather than by text', () => {
      assert.ok(compareValue(false, false, 'equals'));
      assert.notOk(compareValue(0, false, 'equals'), '0 is not false here');
      assert.ok(compareValue('  ', ' ', 'contains'));
    });
  });
});
