import { render } from 'lit';
import { assert, mount, present, settled, unmountAll } from '../../../lib/test/harness.js';
import { compileTemplate } from '@core/template/template.js';
import { configureClock, createManualClock } from '@core/foundation/clock.js';
import { configurePreferences, removePreference } from '@core/preferences/persistence.js';
import { useStandardText } from '../standard-text.js';
import '@components/data/ui-table.js';

/** @import { ManualClock } from '@core/foundation/types.js' */

/**
 * The clock the persist debounce is scheduled on. Installed for every case, so no
 * case waits on real milliseconds and a timer this element left behind is a number
 * to assert rather than a sleep to outlast. ADR-0079.
 *
 * @type {ManualClock}
 */
let clock;

/**
 * The inline style a column's cells carry. Widths and sticky offsets are written
 * there and nowhere else, so this is where a projection that went stale shows.
 *
 * @param {Element} table
 * @param {string} key
 */
function cellStyle(table, key) {
  const cell = table.querySelector(`[data-ui-part="table-cell"][data-column-key="${key}"]`);
  return present(cell, `no cell rendered for column ${key}`).getAttribute('style') ?? '';
}

/** @param {Element} table */
function cellValues(table) {
  return [...table.querySelectorAll('[data-ui-part="table-cell"]')].map(
    (cell) => cell.textContent?.trim() ?? '',
  );
}

/** @param {Element} table */
function rowCheckboxes(table) {
  return /** @type {HTMLInputElement[]} */ ([
    ...table.querySelectorAll('[data-ui-part="table-select-row"]'),
  ]);
}

/** @param {Element} table */
function selectAllCheckbox(table) {
  return /** @type {HTMLInputElement} */ (
    present(table.querySelector('[data-ui-part="table-select-all"]'))
  );
}

/**
 * A click carrying its modifier keys, which `element.click()` cannot express and
 * a shift range is decided by.
 *
 * @param {HTMLElement} element @param {{ shiftKey?: boolean }} [modifiers]
 */
function clickWith(element, modifiers = {}) {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...modifiers }));
}

/** A selectable table over three keyed rows, two to a page. */
function selectionFixture() {
  const table = /** @type {import('@components/data/ui-table.js').UiTable} */ (
    mount(`
      <ui-table page-size="2" page-sizes="2,5" selectable>
        <ui-table-column key="name" label="Name" sortable></ui-table-column>
      </ui-table>
    `)
  );
  table.rows = [
    { id: 1, name: 'Ada' },
    { id: 2, name: 'Grace' },
    { id: 3, name: 'Linus' },
  ];
  return table;
}

/** @returns {import('@components/data/ui-table.js').UiTable} */
function tableFixture() {
  return mount(`
    <ui-table page-size="2" page-sizes="2,5">
      <ui-table-column key="name" label="Name" sortable></ui-table-column>
      <ui-table-column key="meta.team" label="Team"></ui-table-column>
    </ui-table>
  `);
}

describe('ui-table', () => {
  // Every accessible name this element renders is standard text now, so a suite
  // supplies it once through the resolver instead of once per fixture.
  beforeEach(() => {
    useStandardText();
    clock = createManualClock();
    configureClock({ clock });
  });

  afterEach(() => {
    unmountAll();
    configureClock();
    removePreference('ui-table', 'test-employees');
    removePreference('ui-table', 'test-unwritten');
  });

  it('paginates client rows and keeps columns declarative', async () => {
    const table = tableFixture();
    table.rows = [
      { id: 1, name: 'Ada', meta: { team: 'Core' } },
      { id: 2, name: 'Grace', meta: { team: 'Web' } },
      { id: 3, name: 'Linus', meta: { team: 'Core' } },
    ];
    await settled(table);

    assert.equal(table.querySelectorAll('[data-ui-part="table-row"]').length, 2);
    assert.includes(present(table.querySelector('tbody')).textContent ?? '', 'Ada');
    assert.includes(present(table.querySelector('tbody')).textContent ?? '', 'Core');
    assert.equal(present(table.querySelector('[data-ui-part="table-status"]')).textContent?.trim(), '1–2 / 3');

    /** @type {unknown} */
    let detail;
    table.addEventListener('page-change', (event) => {
      detail = /** @type {CustomEvent} */ (event).detail;
    });
    /** @type {HTMLButtonElement} */ (present(table.querySelector('[data-ui-part="table-next"]'))).click();
    await settled(table);

    assert.equal(table.page, 2);
    assert.equal(table.querySelectorAll('[data-ui-part="table-row"]').length, 1);
    assert.includes(present(table.querySelector('tbody')).textContent ?? '', 'Linus');
    assert.equal(/** @type {{ offset?: number }} */ (detail).offset, 2);
  });

  it('leaves server slicing to consumer and emits requested page', async () => {
    const table = tableFixture();
    table.pagination = 'server';
    table.totalRows = 7;
    table.rows = [
      { id: 1, name: 'CTR-1', meta: { team: 'A' } },
      { id: 2, name: 'CTR-2', meta: { team: 'B' } },
    ];
    await settled(table);

    /** @type {{ page?: number, pageSize?: number } | undefined} */
    let requested;
    table.addEventListener('page-change', (event) => {
      requested = /** @type {CustomEvent<{ page: number, pageSize: number }>} */ (event).detail;
    });
    table.goTo(3);
    await settled(table);

    assert.equal(requested?.page, 3);
    assert.equal(requested?.pageSize, 2);
    assert.equal(table.querySelectorAll('[data-ui-part="table-row"]').length, 2);
  });

  it('sorts client rows stably and exposes accessible three-state headers', async () => {
    const table = tableFixture();
    table.rows = [
      { id: 1, name: 'Grace', meta: { team: 'Web' } },
      { id: 2, name: 'Ada', meta: { team: 'Core' } },
      { id: 3, name: 'Ada', meta: { team: 'Research' } },
    ];
    table.page = 2;
    await settled(table);

    /** @type {import('@components/data/ui-table.js').UiTable['query'] | undefined} */
    let query;
    table.addEventListener('query-change', (event) => {
      query = /** @type {CustomEvent<import('@components/data/ui-table.js').UiTable['query']>} */ (event)
        .detail;
    });
    const sort = /** @type {HTMLButtonElement} */ (
      present(table.querySelector('[data-ui-part="table-sort"]'))
    );

    sort.click();
    await settled(table);

    assert.equal(table.page, 1);
    assert.equal(table.sortKey, 'name');
    assert.equal(table.sortDirection, 'asc');
    assert.equal(query?.sort.direction, 'asc');
    assert.equal(
      present(sort.closest('th')).getAttribute('aria-sort'),
      'ascending',
    );
    assert.includes(present(table.querySelector('tbody')).textContent ?? '', 'Ada');
    assert.notOk((present(table.querySelector('tbody')).textContent ?? '').includes('Grace'));

    sort.click();
    await settled(table);
    assert.equal(table.sortDirection, 'desc');
    assert.includes(present(table.querySelector('tbody')).textContent ?? '', 'Grace');

    sort.click();
    await settled(table);
    assert.equal(table.sortKey, '');
    assert.equal(table.sortDirection, '');
    assert.includes(present(table.querySelector('tbody')).textContent ?? '', 'Grace');
  });

  it('applies composable client filters and resets the current page', async () => {
    const table = tableFixture();
    table.rows = [
      { id: 1, name: 'Ada', meta: { team: 'Core' } },
      { id: 2, name: 'Grace', meta: { team: 'Web' } },
      { id: 3, name: 'Linus', meta: { team: 'Core' } },
    ];
    await settled(table);
    table.page = 2;
    await settled(table);

    /** @type {import('@components/data/ui-table.js').UiTable['query'] | undefined} */
    let query;
    table.addEventListener('filter-change', (event) => {
      query = /** @type {CustomEvent<import('@components/data/ui-table.js').UiTable['query']>} */ (event)
        .detail;
    });
    table.filters = [{ key: 'meta.team', value: 'core', match: 'equals' }];
    await settled(table);

    assert.equal(table.page, 1);
    assert.equal(query?.filters.length, 1);
    assert.equal(table.querySelectorAll('[data-ui-part="table-row"]').length, 2);
    assert.includes(present(table.querySelector('tbody')).textContent ?? '', 'Ada');
    assert.includes(present(table.querySelector('tbody')).textContent ?? '', 'Linus');
    assert.notOk((present(table.querySelector('tbody')).textContent ?? '').includes('Grace'));
    assert.equal(
      present(table.querySelector('[data-ui-part="table-status"]')).textContent?.trim(),
      '1–2 / 2',
    );

    table.filters = [{ key: '*', value: 'web' }];
    await settled(table);
    assert.equal(table.querySelectorAll('[data-ui-part="table-row"]').length, 1);
    assert.includes(present(table.querySelector('tbody')).textContent ?? '', 'Grace');
  });

  it('passes filters and sort through server query events without processing rows', async () => {
    const table = tableFixture();
    table.pagination = 'server';
    table.totalRows = 7;
    table.rows = [
      { id: 1, name: 'Zulu', meta: { team: 'A' } },
      { id: 2, name: 'Alpha', meta: { team: 'B' } },
    ];
    await settled(table);

    /** @type {import('@components/data/ui-table.js').UiTable['query'] | undefined} */
    let query;
    table.addEventListener('query-change', (event) => {
      query = /** @type {CustomEvent<import('@components/data/ui-table.js').UiTable['query']>} */ (event)
        .detail;
    });
    table.filters = [{ key: 'status', value: 'open', match: 'equals' }];
    await settled(table);
    /** @type {HTMLButtonElement} */ (
      present(table.querySelector('[data-ui-part="table-sort"]'))
    ).click();
    await settled(table);

    assert.equal(query?.page, 1);
    assert.equal(query?.pageSize, 2);
    assert.equal(query?.offset, 0);
    assert.equal(query?.mode, 'server');
    assert.equal(query?.sort.key, 'name');
    assert.equal(query?.sort.direction, 'asc');
    assert.equal(query?.filters[0]?.key, 'status');
    assert.equal(query?.filters[0]?.value, 'open');
    assert.includes(present(table.querySelector('tbody')).textContent ?? '', 'Zulu');
    assert.includes(present(table.querySelector('tbody')).textContent ?? '', 'Alpha');
  });

  it('exposes infinite loading and row activation as DOM events', async () => {
    const table = tableFixture();
    table.pagination = 'infinite';
    table.totalRows = 4;
    table.rows = [{ id: 1, name: 'Ada', meta: { team: 'Core' } }];
    table.loading = true;
    table.interactive = true;
    await settled(table);

    /** @type {{ offset?: number } | undefined} */
    let more;
    /** @type {{ row?: { name?: string } } | undefined} */
    let activated;
    table.addEventListener('load-more', (event) => {
      more = /** @type {CustomEvent<{ offset: number }>} */ (event).detail;
    });
    table.addEventListener('row-activate', (event) => {
      activated = /** @type {CustomEvent<{ row: { name?: string } }>} */ (event).detail;
    });

    table.loading = false;
    table.requestMore();
    /** @type {HTMLElement} */ (present(table.querySelector('[data-ui-part="table-row"]'))).click();
    await settled(table);

    assert.equal(more?.offset, 1);
    assert.equal(activated?.row?.name, 'Ada');
  });

  it('chooses, reorders, resizes, and sticks columns without changing declarations', async () => {
    const table = /** @type {import('@components/data/ui-table.js').UiTable} */ (mount(`
      <ui-table column-chooser reorderable-columns resizable-columns>
        <ui-table-column key="name" label="Name" hideable width="140"></ui-table-column>
        <ui-table-column key="team" label="Team" hideable></ui-table-column>
        <ui-table-column key="city" label="City" hideable></ui-table-column>
      </ui-table>
    `));
    table.rows = [{ id: 1, name: 'Ada', team: 'Core', city: 'Rome' }];
    await settled(table);

    const name = present(table.columns[0]);
    const team = present(table.columns[1]);
    const city = present(table.columns[2]);
    assert.ok(table.reorderableColumns);
    assert.ok(table.columnReorderable(city));
    assert.sameArray(table.state.columns?.order ?? [], ['name', 'team', 'city']);
    table.toggleColumn(team);
    assert.sameArray(table.state.columns?.order ?? [], ['name', 'team', 'city']);
    assert.ok(table.moveColumn('city', 0));
    assert.sameArray(table.state.columns?.order ?? [], ['city', 'name', 'team']);
    table.setColumnWidth(name, 220);
    table.cycleSticky(city);
    assert.sameArray(table.visibleColumns.map((column) => column.key), ['city', 'name']);
    await settled(table);

    assert.sameArray(
      [...table.querySelectorAll('[data-ui-part="table-header"]')].map((header) =>
        header.getAttribute('data-column-key'),
      ),
      ['city', 'name'],
    );
    assert.equal(table.querySelector('[data-column-key="team"]'), null);
    assert.includes(present(table.querySelector('[data-column-key="name"]')).getAttribute('style') ?? '', '220px');
    assert.includes(present(table.querySelector('[data-column-key="city"]')).getAttribute('style') ?? '', 'position:sticky');
    assert.equal(table.querySelectorAll('ui-table-column').length, 3);
  });

  /**
   * The chooser is one of the three panels that go through `open-panel.js`. The
   * trigger has to claim `aria-expanded` and name a real element, and Escape has
   * to reach the chooser only while it is open. ADR-0078.
   */
  it('announces the chooser, and closes it on a pointer outside the toolbar', async () => {
    const table = /** @type {import('@components/data/ui-table.js').UiTable} */ (mount(`
      <ui-table column-chooser>
        <ui-table-column key="name" label="Name" hideable></ui-table-column>
      </ui-table>
    `));
    table.rows = [{ id: 1, name: 'Ada' }];
    await settled(table);

    const trigger = /** @type {HTMLElement} */ (
      present(table.querySelector('[data-ui-part="table-columns-trigger"]'))
    );
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(trigger.getAttribute('aria-controls'), null);

    trigger.click();
    await settled(table);

    const panel = present(table.querySelector('[data-ui-part="table-columns-panel"]'));
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    assert.equal(trigger.getAttribute('aria-controls'), panel.id, 'and it names the panel');

    // The dismissal region is the toolbar strip rather than the table. A pointer
    // on a row is outside the chooser, and a table fills the screen.
    present(table.querySelector('[data-ui-part="table-cell"]')).dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true }),
    );
    await settled(table);
    assert.notOk(table.columnsOpen);
    assert.equal(trigger.getAttribute('aria-controls'), null, 'and stops naming a panel that went');

    trigger.click();
    await settled(table);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settled(table);
    assert.notOk(table.columnsOpen);
    assert.equal(document.activeElement, trigger, 'focus returns to the trigger');
  });

  /**
   * The column projection covers order, visibility and the offset every sticky
   * column sits at, and it is computed once per change rather than once per cell.
   * Each thing it is derived from has to be a thing the rendered cells still
   * follow.
   *
   * Widths are authored rather than measured, which makes the offsets arithmetic a
   * test can state. `team` starts where `name` ends.
   */
  it('recomputes sticky offsets when order, visibility, or width changes', async () => {
    const table = /** @type {import('@components/data/ui-table.js').UiTable} */ (mount(`
      <ui-table column-chooser reorderable-columns resizable-columns>
        <ui-table-column key="name" label="Name" hideable width="100" sticky="start"></ui-table-column>
        <ui-table-column key="team" label="Team" hideable width="60" sticky="start"></ui-table-column>
        <ui-table-column key="city" label="City" hideable width="80"></ui-table-column>
      </ui-table>
    `));
    table.rows = [{ id: 1, name: 'Ada', team: 'Core', city: 'Rome' }];
    await settled(table);

    const name = present(table.columns[0]);
    const city = present(table.columns[2]);
    assert.includes(cellStyle(table, 'name'), 'inset-inline-start:0px', 'the first sticky column');
    assert.includes(cellStyle(table, 'team'), 'inset-inline-start:100px', 'starts where the first ends');

    table.setColumnWidth(name, 140);
    await settled(table);
    assert.includes(cellStyle(table, 'team'), 'inset-inline-start:140px', 'a resize moves what follows');

    table.toggleColumn(name);
    await settled(table);
    assert.equal(table.querySelector('[data-column-key="name"]'), null, 'hidden means not rendered');
    assert.includes(cellStyle(table, 'team'), 'inset-inline-start:0px', 'and nothing is left in front');

    table.cycleSticky(city);
    await settled(table);
    assert.includes(cellStyle(table, 'city'), 'inset-inline-start:60px', 'a new sticky column queues up');

    assert.ok(table.moveColumn('city', 0));
    await settled(table);
    assert.sameArray(table.visibleColumns.map((column) => column.key), ['city', 'team']);
    assert.includes(cellStyle(table, 'city'), 'inset-inline-start:0px', 'reordering re-stacks them');
    assert.includes(cellStyle(table, 'team'), 'inset-inline-start:80px');
  });

  /**
   * Processed rows are cached on the identity of everything they are computed
   * from, and a column is one of those things. The same rows under the same sort
   * key sort differently once the column says how to read its value, and a cache
   * that misses this leaves the table stuck in its previous order.
   */
  it('reprocesses rows when a column changes how it sorts', async () => {
    const table = /** @type {import('@components/data/ui-table.js').UiTable} */ (mount(`
      <ui-table page-size="5">
        <ui-table-column key="name" label="Name" sortable></ui-table-column>
      </ui-table>
    `));
    table.rows = [{ id: 1, name: 'b' }, { id: 2, name: 'a' }, { id: 3, name: 'c' }];
    await settled(table);

    const name = present(table.columns[0]);
    table.toggleSort(name);
    await settled(table);
    assert.sameArray(cellValues(table), ['a', 'b', 'c']);

    name.sortValue = (_row, _index, value) => -String(value).charCodeAt(0);
    await settled(table);
    assert.sameArray(cellValues(table), ['c', 'b', 'a'], 'the same sort key, a new answer');

    table.filters = [{ key: 'name', value: 'b', match: 'equals' }];
    await settled(table);
    assert.sameArray(cellValues(table), ['b'], 'a new filters array is a new identity');
  });

  /**
   * The whole authoring path, as a page walks it. The compiler turns a
   * `<template *fragment>` into a value, lit assigns it to the column, the table
   * captures the column as projected content and moves it into `<x-content>`, and
   * the cell renders from a scope that belongs to the page. Every earlier test
   * here sets `cell` by hand, which would pass even if the column never survived
   * projection with its property intact. ADR-0104.
   */
  it('renders a cell fragment a consumer template declared', async () => {
    const page = compileTemplate(
      `<ui-table page-size="5" [.rows]="rows">
         <ui-table-column key="name" label="Name">
           <template *fragment="cell(person of rows)">
             <b>{{ prefix }}{{ person.name }}</b>
           </template>
         </ui-table-column>
       </ui-table>`,
      'page',
    );
    const model = { rows: [{ id: 1, name: 'Ada' }, { id: 2, name: 'Grace' }], prefix: '#' };

    const container = mount('<div></div>');
    render(page(model), container);
    const table = /** @type {import('@components/data/ui-table.js').UiTable} */ (
      present(container.querySelector('ui-table'))
    );
    await settled(table);

    assert.sameArray(cellValues(table), ['#Ada', '#Grace']);
    assert.equal(
      table.querySelector('template'),
      null,
      'the declaration must leave no markup behind',
    );

    // The fragment reads the page, so a page render reaches the cells.
    model.prefix = '>';
    render(page(model), container);
    await settled(table);
    assert.sameArray(cellValues(table), ['>Ada', '>Grace']);
  });

  /**
   * A column offers two ways to write a rich cell, and the table has to choose
   * between them the same way every time. `cell` is authored markup a page declares
   * in its own template, which `template.js` compiles into a function handed to the
   * column. `renderer` is the computed escape hatch. The fragment is more specific,
   * so it wins, and it is reached even when the row holds nothing at the column's
   * key.
   */
  it('prefers a column fragment over its renderer, empty value or not', async () => {
    const table = /** @type {import('@components/data/ui-table.js').UiTable} */ (mount(`
      <ui-table page-size="5">
        <ui-table-column key="name" label="Name"></ui-table-column>
        <ui-table-column key="missing" label="Missing"></ui-table-column>
      </ui-table>
    `));
    table.rows = [{ id: 1, name: 'Ada' }];
    await settled(table);

    const [name, missing] = table.columns;
    present(name).renderer = (_row, _index, value) => `computed ${String(value)}`;
    await settled(table);
    assert.sameArray(cellValues(table), ['computed Ada', '']);

    present(name).cell = (_row, index, value) => `authored ${String(value)} ${String(index)}`;
    present(missing).cell = () => 'always';
    await settled(table);
    assert.sameArray(cellValues(table), ['authored Ada 0', 'always']);

    present(name).cell = undefined;
    await settled(table);
    assert.sameArray(cellValues(table), ['computed Ada', 'always']);
  });

  /**
   * Each of these leaks differently. An observer holds the element alive, a
   * debounced write lands after the screen is gone, and a panel promoted to the top
   * layer stays there over whatever the user navigated to. `onDestroy` is the only
   * place they are released, so one test covers the whole set.
   */
  it('releases the panel, the pending write, and the sentinel on unmount', async () => {
    /** @type {string[]} */
    const writes = [];
    configurePreferences({
      storage: {
        getItem: () => null,
        setItem: (key) => void writes.push(key),
        removeItem: () => undefined,
      },
    });

    try {
      const table = /** @type {import('@components/data/ui-table.js').UiTable} */ (mount(`
        <ui-table state-id="test-employees" pagination="infinite" page-size="2" column-chooser resizable-columns>
          <ui-table-column key="name" label="Name" hideable resizable></ui-table-column>
        </ui-table>
      `));
      table.totalRows = 10;
      table.rows = [{ id: 1, name: 'Ada' }, { id: 2, name: 'Grace' }];
      table.columnsOpen = true;
      await settled(table);

      /** @type {unknown[]} */
      const requests = [];
      table.addEventListener('load-more', (event) => void requests.push(event));

      const panel = present(table.querySelector('[data-ui-part="table-columns-panel"]'));
      assert.equal(document.querySelector(':popover-open'), panel, 'the open chooser is the top layer');
      assert.ok(
        table.querySelector('[data-ui-part="table-infinite"]') !== null,
        'infinite mode renders the sentinel the observer watches',
      );

      table.columnsOpen = false;
      await settled(table);
      assert.equal(document.querySelector(':popover-open'), null, 'closing it empties the top layer');

      table.resizeFromKeyboard(
        present(table.columns[0]),
        new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true }),
      );
      assert.equal(writes.length, 0, 'the write is still waiting for the burst to end');
      assert.equal(clock.pending, 1, 'and is on the clock rather than already gone');

      unmountAll();
      const asked = requests.length;
      assert.equal(writes.length, 1, 'unmounting flushes it');
      assert.notOk(table.isConnected);
      assert.equal(document.querySelector('[data-ui-part="table-row"]'), null, 'and takes the rows with it');

      // A timer that survived the flush would still be on the clock, and draining
      // the clock would fire it. Both are claims about what is scheduled, which a
      // sleep past the debounce cannot make.
      assert.equal(clock.pending, 0, 'the flush cancelled the timer rather than leaving it');
      clock.flush();
      assert.equal(writes.length, 1, 'so nothing writes a second time');
      assert.equal(requests.length, asked, 'the released observer asks for nothing more');
    } finally {
      configurePreferences();
    }
  });

  it('restores query and column configuration by stable state id', async () => {
    const markup = `
      <ui-table
        state-id="test-employees"
        page-size="2"
        reorderable-columns
        resizable-columns
        page-sizes="2,5"
      >
        <ui-table-column key="name" label="Name" sortable hideable width="140"></ui-table-column>
        <ui-table-column key="team" label="Team" hideable></ui-table-column>
        <ui-table-column key="city" label="City" hideable></ui-table-column>
      </ui-table>
    `;
    let table = /** @type {import('@components/data/ui-table.js').UiTable} */ (mount(markup));
    table.rows = [
      { id: 1, name: 'Ada', team: 'Core', city: 'Rome' },
      { id: 2, name: 'Grace', team: 'Web', city: 'New York' },
      { id: 3, name: 'Linus', team: 'Core', city: 'Helsinki' },
    ];
    await settled(table);
    const name = present(table.columns[0]);
    const team = present(table.columns[1]);
    const city = present(table.columns[2]);
    table.toggleSort(name);
    table.goTo(2);
    table.toggleColumn(team);
    table.moveColumn('city', 0);
    table.setColumnWidth(name, 230);
    table.cycleSticky(city);
    table.saveState();
    await settled(table);

    unmountAll();
    table = /** @type {import('@components/data/ui-table.js').UiTable} */ (mount(markup));
    table.rows = [
      { id: 1, name: 'Ada', team: 'Core', city: 'Rome' },
      { id: 2, name: 'Grace', team: 'Web', city: 'New York' },
      { id: 3, name: 'Linus', team: 'Core', city: 'Helsinki' },
    ];
    await settled(table);

    assert.equal(table.page, 2);
    assert.equal(table.sortKey, 'name');
    assert.equal(table.sortDirection, 'asc');
    assert.sameArray(table.visibleColumns.map((column) => column.key), ['city', 'name']);
    assert.equal(table.columnWidth(present(table.columns[0])), 230);
    assert.equal(table.columnSticky(present(table.columns[2])), 'start');
  });

  /**
   * `table-name` is the older spelling of `state-id`, kept because pages are
   * authored against it. Two attributes for one concept stay honest only while
   * something checks that they mean the same thing, and that `state-id` wins when a
   * page carries both, which is what the collection's contract promises.
   */
  it('persists under table-name, and lets state-id win over it', async () => {
    const aliased = `
      <ui-table table-name="test-employees" page-size="2" page-sizes="2,5">
        <ui-table-column key="name" label="Name" sortable></ui-table-column>
      </ui-table>
    `;
    let table = /** @type {import('@components/data/ui-table.js').UiTable} */ (mount(aliased));
    table.rows = [{ id: 1, name: 'Ada' }, { id: 2, name: 'Grace' }, { id: 3, name: 'Linus' }];
    await settled(table);
    table.goTo(2);
    table.saveState();
    await settled(table);

    unmountAll();
    table = /** @type {import('@components/data/ui-table.js').UiTable} */ (mount(aliased));
    table.rows = [{ id: 1, name: 'Ada' }, { id: 2, name: 'Grace' }, { id: 3, name: 'Linus' }];
    await settled(table);
    assert.equal(table.page, 2, 'table-name must reach the same stored state state-id does');

    unmountAll();
    table = /** @type {import('@components/data/ui-table.js').UiTable} */ (
      mount(`
        <ui-table state-id="test-unwritten" table-name="test-employees" page-size="2" page-sizes="2,5">
          <ui-table-column key="name" label="Name" sortable></ui-table-column>
        </ui-table>
      `)
    );
    table.rows = [{ id: 1, name: 'Ada' }, { id: 2, name: 'Grace' }, { id: 3, name: 'Linus' }];
    await settled(table);
    assert.equal(table.page, 1, 'state-id wins, so the table-name entry is not read');
  });

  /* ── Selection ─────────────────────────────────────────────────────────── */

  /**
   * Why a selection is keyed rather than positional. A bulk action is chosen on
   * one page, under one sort, and performed after both have moved.
   */
  it('keeps chosen rows through sorting and page changes', async () => {
    const table = selectionFixture();
    await settled(table);

    /** @type {import('@components/data/ui-table.js').UiTable['selectedKeys'][]} */
    const emitted = [];
    table.addEventListener('selection-change', (event) => {
      emitted.push(/** @type {CustomEvent<{ keys: readonly unknown[] }>} */ (event).detail.keys);
    });

    clickWith(present(rowCheckboxes(table)[0]));
    await settled(table);
    assert.sameArray([...table.selectedKeys], [1]);
    assert.equal(emitted.length, 1);

    table.toggleSort(present(table.columns[0]));
    table.sortDirection = 'desc';
    await settled(table);
    assert.sameArray([...table.selectedKeys], [1], 'a sort moves rows, not the selection');

    // Descending puts Ada last, so page two is the row that was chosen on page one.
    table.goTo(2);
    await settled(table);
    assert.sameArray([...table.selectedKeys], [1]);
    assert.ok(
      present(rowCheckboxes(table)[0]).checked,
      'the chosen row is still chosen where the sort moved it',
    );

    table.goTo(1);
    await settled(table);
    assert.sameArray(
      table.selectedRows.map((row) => /** @type {{ name: string }} */ (row).name),
      ['Ada'],
      'the rows behind the keys come back in row order',
    );
  });

  /**
   * The header acts on what the user can see. Anything wider than the page, such
   * as every loaded row or every matching record on a server, is a screen's
   * decision rather than a checkbox's.
   */
  it('selects the page from the header and reports a mixed page as indeterminate', async () => {
    const table = selectionFixture();
    await settled(table);

    selectAllCheckbox(table).click();
    await settled(table);
    assert.sameArray([...table.selectedKeys], [1, 2], 'the page, not the collection');
    assert.ok(selectAllCheckbox(table).checked);
    assert.notOk(selectAllCheckbox(table).indeterminate);

    clickWith(present(rowCheckboxes(table)[1]));
    await settled(table);
    assert.sameArray([...table.selectedKeys], [1]);
    assert.notOk(selectAllCheckbox(table).checked);
    assert.ok(selectAllCheckbox(table).indeterminate, 'one of two is mixed');

    selectAllCheckbox(table).click();
    await settled(table);
    assert.sameArray([...table.selectedKeys], [1, 2]);

    selectAllCheckbox(table).click();
    await settled(table);
    assert.sameArray([...table.selectedKeys], [], 'a full page toggles off');
  });

  it('extends a range with shift, and starts a new anchor from the last row clicked', async () => {
    const table = selectionFixture();
    table.pagination = 'none';
    table.rows = [
      { id: 1, name: 'Ada' },
      { id: 2, name: 'Grace' },
      { id: 3, name: 'Linus' },
      { id: 4, name: 'Alan' },
    ];
    await settled(table);

    clickWith(present(rowCheckboxes(table)[0]));
    await settled(table);
    clickWith(present(rowCheckboxes(table)[2]), { shiftKey: true });
    await settled(table);
    assert.sameArray([...table.selectedKeys], [1, 2, 3]);

    // The anchor is the row last clicked, so this shift-click clears back to it.
    clickWith(present(rowCheckboxes(table)[1]), { shiftKey: true });
    await settled(table);
    assert.sameArray([...table.selectedKeys], [1], 'a shift range applies the clicked row\'s new state');
  });

  it('refuses rows the screen disables, one by one and in bulk', async () => {
    const table = selectionFixture();
    table.pagination = 'none';
    table.rowSelectable = (row) => /** @type {{ name: string }} */ (row).name !== 'Grace';
    await settled(table);

    const boxes = rowCheckboxes(table);
    assert.notOk(present(boxes[0]).disabled);
    assert.ok(present(boxes[1]).disabled, 'a refused row says so rather than failing on click');

    table.toggleRow(present(table.rows[1]), 1);
    await settled(table);
    assert.sameArray([...table.selectedKeys], [], 'the interface refuses it too, not only the DOM');

    selectAllCheckbox(table).click();
    await settled(table);
    assert.sameArray([...table.selectedKeys], [1, 3], 'select-all steps over what it may not choose');
    assert.ok(selectAllCheckbox(table).checked, 'every row it may choose is chosen');

    clickWith(present(boxes[0]));
    clickWith(present(rowCheckboxes(table)[2]), { shiftKey: true });
    await settled(table);
    assert.sameArray([...table.selectedKeys], [], 'a range steps over it as well');
  });

  it('drops keys whose rows are gone, and keeps them across server pages', async () => {
    const table = selectionFixture();
    await settled(table);

    selectAllCheckbox(table).click();
    await settled(table);
    assert.sameArray([...table.selectedKeys], [1, 2]);

    /** @type {readonly unknown[] | undefined} */
    let pruned;
    table.addEventListener('selection-change', (event) => {
      pruned = /** @type {CustomEvent<{ keys: readonly unknown[] }>} */ (event).detail.keys;
    });
    table.rows = [{ id: 2, name: 'Grace' }, { id: 3, name: 'Linus' }];
    await settled(table);
    assert.sameArray([...table.selectedKeys], [2], 'a row this table no longer holds is not chosen');
    assert.sameArray([...present(pruned)], [2], 'and the screen is told');

    // A server table holds one page, so an absent key means "elsewhere".
    table.pagination = 'server';
    table.totalRows = 4;
    table.rows = [{ id: 7, name: 'Alan' }, { id: 8, name: 'Edsger' }];
    await settled(table);
    assert.sameArray([...table.selectedKeys], [2], 'paging must not empty a server selection');
    assert.sameArray([...table.selectedRows], [], 'and the rows behind it are the loaded ones');
  });

  it('will not select a row it cannot name', async () => {
    const table = selectionFixture();
    table.pagination = 'none';
    table.rows = [{ id: 1, name: 'Ada' }, { name: 'Anonymous' }];
    await settled(table);

    const boxes = rowCheckboxes(table);
    assert.notOk(present(boxes[0]).disabled);
    assert.ok(present(boxes[1]).disabled, 'no id, no identity, no selection');

    selectAllCheckbox(table).click();
    await settled(table);
    assert.sameArray([...table.selectedKeys], [1]);
  });

  /**
   * The row carries the activation handler, so a keypress inside a cell reaches
   * it by bubbling. Preventing the default there would take Space away from the
   * control the user is standing on.
   */
  it('leaves Space to the checkbox in an interactive table', async () => {
    const table = selectionFixture();
    table.interactive = true;
    await settled(table);

    let activated = 0;
    table.addEventListener('row-activate', () => {
      activated += 1;
    });

    const box = present(rowCheckboxes(table)[0]);
    const keypress = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    box.dispatchEvent(keypress);
    assert.notOk(keypress.defaultPrevented, 'the checkbox still owns Space');
    assert.equal(activated, 0);

    const row = present(table.querySelector('[data-ui-part="table-row"]'));
    const onRow = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    row.dispatchEvent(onRow);
    assert.equal(activated, 1, 'the row itself still activates');
  });

  it('spans the selection column in the empty and loading rows', async () => {
    const table = selectionFixture();
    table.rows = [];
    await settled(table);

    assert.equal(
      present(table.querySelector('[data-ui-part="table-empty"] td')).getAttribute('colspan'),
      '2',
      'one declared column plus the selection column',
    );
  });

  /**
   * Holding an arrow key on a resize handle is one config change per keypress, and
   * each would otherwise be a `JSON.stringify` of the whole column model into
   * storage. The internal triggers coalesce, and `saveState()` stays immediate for
   * a consumer that means now.
   */
  it('coalesces a burst of column changes into one write', async () => {
    /** @type {string[]} */
    const writes = [];
    configurePreferences({
      storage: {
        getItem: () => null,
        setItem: (key) => void writes.push(key),
        removeItem: () => undefined,
      },
    });

    try {
      const table = /** @type {import('@components/data/ui-table.js').UiTable} */ (
        mount(`
          <ui-table state-id="test-employees" page-size="2" page-sizes="2,5" resizable-columns>
            <ui-table-column key="name" label="Name" resizable></ui-table-column>
          </ui-table>
        `)
      );
      table.rows = [{ id: 1, name: 'Ada' }, { id: 2, name: 'Grace' }, { id: 3, name: 'Linus' }];
      await settled(table);

      const name = present(table.columns[0]);
      for (let press = 0; press < 5; press += 1) {
        table.resizeFromKeyboard(
          name,
          new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true }),
        );
      }
      await settled(table);
      assert.equal(writes.length, 0, 'a burst must not reach storage while it is still arriving');
      assert.equal(clock.pending, 1, 'five keypresses are one scheduled write, not five');

      // Unmounting flushes, so the burst is not lost by navigating away.
      unmountAll();
      assert.equal(writes.length, 1);
    } finally {
      configurePreferences();
    }
  });

  /* ── Row window ──────────────────────────────────────────────────────── */

  /**
   * A windowed table over `count` rows, with a scroller short enough that the
   * window is a small fraction of them.
   *
   * The heights are declared rather than left to a stylesheet, so the arithmetic
   * has something to start from; every assertion below reads the height the
   * browser actually laid out, because a suite that hard-codes 24 is asserting
   * this file's padding rather than the window.
   *
   * @param {number} count
   * @param {string} [attributes]
   */
  function windowFixture(count, attributes = '') {
    const table = /** @type {import('@components/data/ui-table.js').UiTable} */ (
      mount(`
        <ui-table
          pagination="none"
          virtualized
          row-height="24"
          viewport-height="120"
          ${attributes}
        >
          <ui-table-column key="name" label="Name" sortable></ui-table-column>
        </ui-table>
      `)
    );
    table.rows = Array.from({ length: count }, (_unused, index) => ({
      id: index + 1,
      name: `Row ${String(index + 1)}`,
    }));
    return table;
  }

  /** @param {Element} table */
  function renderedRows(table) {
    return [...table.querySelectorAll('[data-ui-part="table-row"]')];
  }

  /** The page indices the DOM is currently holding. @param {Element} table */
  function renderedIndices(table) {
    return renderedRows(table).map((row) => Number(row.getAttribute('data-row-index')));
  }

  /** @param {Element} table */
  function scroller(table) {
    return /** @type {HTMLElement} */ (present(table.querySelector('[data-ui-part="table-scroll"]')));
  }

  /** The height one laid-out row occupies, which the window is computed from. */
  /** @param {Element} table */
  function laidOutRowHeight(table) {
    const first = present(renderedRows(table)[0], 'no row rendered to measure');
    return Math.round(first.getBoundingClientRect().height);
  }

  /**
   * Scroll to the row at `index` and let the window follow.
   *
   * @param {import('@components/data/ui-table.js').UiTable} table
   * @param {number} index
   */
  async function scrollToRow(table, index) {
    const element = scroller(table);
    element.scrollTop = index * laidOutRowHeight(table);
    element.dispatchEvent(new Event('scroll'));
    await settled(table);
  }

  it('renders a window of the page rather than all of it', async () => {
    const table = windowFixture(2000);
    await settled(table);

    const rows = renderedRows(table);
    assert.ok(rows.length > 0, 'the window must render something');
    assert.ok(rows.length < 100, `expected a small window, rendered ${String(rows.length)} rows`);
    assert.equal(table.visibleRows.length, 2000, 'the page is still every row');
    assert.equal(renderedIndices(table)[0], 0, 'an unscrolled window starts at the first row');
    assert.includes(present(table.querySelector('tbody')).textContent ?? '', 'Row 1');
  });

  it('holds the scroll extent of the rows it did not render', async () => {
    const table = windowFixture(2000);
    await settled(table);

    const height = laidOutRowHeight(table);
    const below = present(table.querySelector('[data-ui-part="table-space-below"]'));
    const rendered = renderedRows(table).length;

    assert.equal(
      Math.round(below.getBoundingClientRect().height),
      (2000 - rendered) * height,
      'the spacer stands in for every row outside the window',
    );
    assert.equal(
      table.querySelector('[data-ui-part="table-space-above"]'),
      null,
      'nothing is above the first row',
    );
  });

  it('moves the window to the rows the scroller is showing', async () => {
    const table = windowFixture(2000);
    await settled(table);
    await scrollToRow(table, 900);

    const indices = renderedIndices(table);
    const first = present(indices[0]);
    assert.ok(first > 880 && first <= 900, `window starts at ${String(first)}, expected near 900`);
    assert.includes(
      present(table.querySelector('tbody')).textContent ?? '',
      `Row ${String(first + 1)}`,
    );
    assert.notOk(indices.includes(0), 'the first row is no longer in the DOM');

    const above = present(table.querySelector('[data-ui-part="table-space-above"]'));
    assert.equal(
      Math.round(above.getBoundingClientRect().height),
      first * laidOutRowHeight(table),
      'the spacer above matches where the window starts',
    );
  });

  it('numbers the rendered rows against the whole page for assistive technology', async () => {
    const table = windowFixture(2000);
    await settled(table);
    await scrollToRow(table, 500);

    assert.equal(
      present(table.querySelector('[data-ui-part="table"]')).getAttribute('aria-rowcount'),
      '2001',
      'every row plus the header',
    );
    assert.equal(
      present(table.querySelector('thead tr')).getAttribute('aria-rowindex'),
      '1',
    );
    const first = present(renderedRows(table)[0]);
    assert.equal(
      first.getAttribute('aria-rowindex'),
      String(Number(first.getAttribute('data-row-index')) + 2),
      'a row is numbered one-based, after the header',
    );
    assert.equal(
      present(table.querySelector('[data-ui-part="table-space-above"]')).getAttribute('aria-hidden'),
      'true',
      'a spacer is not a row',
    );
  });

  it('keeps selection over the whole page while rendering a window of it', async () => {
    const table = windowFixture(2000, 'selectable');
    await settled(table);
    assert.ok(renderedRows(table).length < 2000, 'the fixture is windowed');

    /** @type {{ keys: readonly unknown[], scope: string } | undefined} */
    let selection;
    table.addEventListener('selection-change', (event) => {
      selection = /** @type {CustomEvent<{ keys: readonly unknown[], scope: string }>} */ (event).detail;
    });

    selectAllCheckbox(table).click();
    await settled(table);

    assert.equal(selection?.keys.length, 2000, 'select-all covers the page, not the window');
    assert.equal(table.selectionCount, 2000);
    assert.ok(table.allPageRowsSelected, 'the header reads as fully selected');

    await scrollToRow(table, 1500);
    assert.ok(
      rowCheckboxes(table).every((box) => box.checked),
      'a row scrolled into the window arrives already selected',
    );
  });

  it('keeps keyboard focus in the table when a scroll unmounts the focused row', async () => {
    const table = windowFixture(2000, 'interactive');
    await settled(table);

    const focused = present(renderedRows(table)[1]);
    /** @type {HTMLElement} */ (focused).focus();
    assert.equal(document.activeElement, focused);

    await scrollToRow(table, 1200);

    const active = present(document.activeElement);
    assert.ok(table.contains(active), 'focus stayed inside the table');
    assert.equal(
      active.getAttribute('data-ui-part'),
      'table-row',
      'focus moved to a row, not to the scroller',
    );
    assert.equal(
      active.getAttribute('data-row-index'),
      String(present(renderedIndices(table)[0])),
      'focus landed on the nearest surviving row',
    );
  });

  it('renders a replaced row that is inside the window', async () => {
    const table = windowFixture(2000);
    await settled(table);
    await scrollToRow(table, 700);
    assert.ok(renderedRows(table).length < 2000, 'the fixture is windowed');

    const before = present(renderedIndices(table)[0]);
    const index = present(renderedIndices(table)[2]);
    const rows = [...table.rows];
    rows[index] = { id: index + 1, name: 'Renamed' };
    table.rows = rows;
    await settled(table);

    assert.includes(present(table.querySelector('tbody')).textContent ?? '', 'Renamed');
    assert.equal(
      present(renderedIndices(table)[0]),
      before,
      'the window did not move because a row changed',
    );
  });

  it('sends the window back to the top when the page it shows changes', async () => {
    const table = /** @type {import('@components/data/ui-table.js').UiTable} */ (
      mount(`
        <ui-table pagination="client" page-size="500" page-sizes="500" virtualized
                  row-height="24" viewport-height="120">
          <ui-table-column key="name" label="Name" sortable></ui-table-column>
        </ui-table>
      `)
    );
    table.rows = Array.from({ length: 1500 }, (_unused, index) => ({
      id: index + 1,
      name: `Row ${String(index + 1)}`,
    }));
    await settled(table);
    await scrollToRow(table, 300);
    assert.ok(renderedRows(table).length < 500, 'the fixture is windowed');
    assert.ok(scroller(table).scrollTop > 0, 'the fixture is scrolled before the page changes');

    table.goTo(2);
    await settled(table);

    assert.equal(scroller(table).scrollTop, 0, 'a new page opens at its first row');
    assert.equal(renderedIndices(table)[0], 0);
    assert.includes(present(table.querySelector('tbody')).textContent ?? '', 'Row 501');
  });

  it('asks for the next page when the window reaches the last loaded row', async () => {
    const table = /** @type {import('@components/data/ui-table.js').UiTable} */ (
      mount(`
        <ui-table pagination="infinite" page-size="200" virtualized
                  row-height="24" viewport-height="120">
          <ui-table-column key="name" label="Name"></ui-table-column>
        </ui-table>
      `)
    );
    table.totalRows = 1000;
    table.rows = Array.from({ length: 400 }, (_unused, index) => ({
      id: index + 1,
      name: `Row ${String(index + 1)}`,
    }));
    await settled(table);

    /** @type {{ offset?: number } | undefined} */
    let requested;
    table.addEventListener('load-more', (event) => {
      requested = /** @type {CustomEvent<{ offset: number }>} */ (event).detail;
    });

    await scrollToRow(table, 399);

    assert.equal(requested?.offset, 400, 'the window asks for what comes after the loaded rows');
  });

  it('renders every row again when the window is turned off', async () => {
    const table = windowFixture(300);
    await settled(table);
    assert.ok(renderedRows(table).length < 300);

    table.virtualized = false;
    await settled(table);

    assert.equal(renderedRows(table).length, 300, 'an unwindowed table renders its page');
    assert.equal(table.querySelector('[data-ui-part="table-space-below"]'), null);
    assert.equal(
      present(table.querySelector('[data-ui-part="table"]')).getAttribute('aria-rowcount'),
      null,
      'a table rendering every row does not have to say how many there are',
    );
  });
});
