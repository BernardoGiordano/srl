import { assert, mount, present, settled, unmountAll } from '../../../lib/test/harness.js';
import { configurePreferences, removePreference } from '@core/preferences/persistence.js';
import { useStandardText } from '../standard-text.js';
import '@components/data/ui-table.js';

/** @param {Element} element */
async function ready(element) {
  await settled(element);
  for (const child of element.querySelectorAll('*')) {
    const updatable = /** @type {{ updateComplete?: Promise<unknown> }} */ (child);
    if (updatable.updateComplete !== undefined) await updatable.updateComplete;
  }
  await settled(element);
}

/** @param {number} ms */
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  beforeEach(() => useStandardText());

  afterEach(() => {
    unmountAll();
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
    await ready(table);

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
    await ready(table);

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
    await ready(table);

    /** @type {{ page?: number, pageSize?: number } | undefined} */
    let requested;
    table.addEventListener('page-change', (event) => {
      requested = /** @type {CustomEvent<{ page: number, pageSize: number }>} */ (event).detail;
    });
    table.goTo(3);
    await ready(table);

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
    await ready(table);

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
    await ready(table);

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
    await ready(table);
    assert.equal(table.sortDirection, 'desc');
    assert.includes(present(table.querySelector('tbody')).textContent ?? '', 'Grace');

    sort.click();
    await ready(table);
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
    await ready(table);
    table.page = 2;
    await ready(table);

    /** @type {import('@components/data/ui-table.js').UiTable['query'] | undefined} */
    let query;
    table.addEventListener('filter-change', (event) => {
      query = /** @type {CustomEvent<import('@components/data/ui-table.js').UiTable['query']>} */ (event)
        .detail;
    });
    table.filters = [{ key: 'meta.team', value: 'core', match: 'equals' }];
    await ready(table);

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
    await ready(table);
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
    await ready(table);

    /** @type {import('@components/data/ui-table.js').UiTable['query'] | undefined} */
    let query;
    table.addEventListener('query-change', (event) => {
      query = /** @type {CustomEvent<import('@components/data/ui-table.js').UiTable['query']>} */ (event)
        .detail;
    });
    table.filters = [{ key: 'status', value: 'open', match: 'equals' }];
    await ready(table);
    /** @type {HTMLButtonElement} */ (
      present(table.querySelector('[data-ui-part="table-sort"]'))
    ).click();
    await ready(table);

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
    await ready(table);

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
    await ready(table);

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
    await ready(table);

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
    await ready(table);

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
   * The chooser is one of the three panels that go through `open-panel.js`, and
   * the one that had least of this before: the trigger claimed `aria-expanded`
   * and named nothing at all, and Escape closed the chooser from anywhere in the
   * document whether or not it was open. ADR-0078.
   */
  it('announces the chooser, and closes it on a pointer outside the toolbar', async () => {
    const table = /** @type {import('@components/data/ui-table.js').UiTable} */ (mount(`
      <ui-table column-chooser>
        <ui-table-column key="name" label="Name" hideable></ui-table-column>
      </ui-table>
    `));
    table.rows = [{ id: 1, name: 'Ada' }];
    await ready(table);

    const trigger = /** @type {HTMLElement} */ (
      present(table.querySelector('[data-ui-part="table-columns-trigger"]'))
    );
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(trigger.getAttribute('aria-controls'), null);

    trigger.click();
    await ready(table);

    const panel = present(table.querySelector('[data-ui-part="table-columns-panel"]'));
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    assert.equal(trigger.getAttribute('aria-controls'), panel.id, 'and it names the panel');

    // The dismissal region is the toolbar strip, not the table: a pointer on a
    // row is outside the chooser, and a table fills the screen.
    present(table.querySelector('[data-ui-part="table-cell"]')).dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true }),
    );
    await ready(table);
    assert.notOk(table.columnsOpen);
    assert.equal(trigger.getAttribute('aria-controls'), null, 'and stops naming a panel that went');

    trigger.click();
    await ready(table);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await ready(table);
    assert.notOk(table.columnsOpen);
    assert.equal(document.activeElement, trigger, 'focus returns to the trigger');
  });

  /**
   * The column projection — order, visibility, and the offset every sticky column
   * sits at — is computed once per change rather than once per cell. So each thing
   * it is derived from has to be a thing the rendered cells still follow.
   *
   * Widths are authored rather than measured, which is what makes an offset
   * arithmetic a test can state: `team` starts where `name` ends.
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
    await ready(table);

    const name = present(table.columns[0]);
    const city = present(table.columns[2]);
    assert.includes(cellStyle(table, 'name'), 'inset-inline-start:0px', 'the first sticky column');
    assert.includes(cellStyle(table, 'team'), 'inset-inline-start:100px', 'starts where the first ends');

    table.setColumnWidth(name, 140);
    await ready(table);
    assert.includes(cellStyle(table, 'team'), 'inset-inline-start:140px', 'a resize moves what follows');

    table.toggleColumn(name);
    await ready(table);
    assert.equal(table.querySelector('[data-column-key="name"]'), null, 'hidden means not rendered');
    assert.includes(cellStyle(table, 'team'), 'inset-inline-start:0px', 'and nothing is left in front');

    table.cycleSticky(city);
    await ready(table);
    assert.includes(cellStyle(table, 'city'), 'inset-inline-start:60px', 'a new sticky column queues up');

    assert.ok(table.moveColumn('city', 0));
    await ready(table);
    assert.sameArray(table.visibleColumns.map((column) => column.key), ['city', 'team']);
    assert.includes(cellStyle(table, 'city'), 'inset-inline-start:0px', 'reordering re-stacks them');
    assert.includes(cellStyle(table, 'team'), 'inset-inline-start:80px');
  });

  /**
   * Processed rows are cached on the identity of everything they are computed
   * from, and a column is one of those things: the same rows under the same sort
   * key sort differently once the column says how to read its value. The cache
   * that missed this would be a table stuck in its previous order.
   */
  it('reprocesses rows when a column changes how it sorts', async () => {
    const table = /** @type {import('@components/data/ui-table.js').UiTable} */ (mount(`
      <ui-table page-size="5">
        <ui-table-column key="name" label="Name" sortable></ui-table-column>
      </ui-table>
    `));
    table.rows = [{ id: 1, name: 'b' }, { id: 2, name: 'a' }, { id: 3, name: 'c' }];
    await ready(table);

    const name = present(table.columns[0]);
    table.toggleSort(name);
    await ready(table);
    assert.sameArray(cellValues(table), ['a', 'b', 'c']);

    name.sortValue = (_row, _index, value) => -String(value).charCodeAt(0);
    await ready(table);
    assert.sameArray(cellValues(table), ['c', 'b', 'a'], 'the same sort key, a new answer');

    table.filters = [{ key: 'name', value: 'b', match: 'equals' }];
    await ready(table);
    assert.sameArray(cellValues(table), ['b'], 'a new filters array is a new identity');
  });

  /**
   * Each of these leaks differently: an observer holds the element alive, a
   * debounced write lands after the screen is gone, a panel promoted to the top
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
      await ready(table);

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
      await ready(table);
      assert.equal(document.querySelector(':popover-open'), null, 'closing it empties the top layer');

      table.resizeFromKeyboard(
        present(table.columns[0]),
        new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true }),
      );
      assert.equal(writes.length, 0, 'the write is still waiting for the burst to end');

      unmountAll();
      const asked = requests.length;
      assert.equal(writes.length, 1, 'unmounting flushes it');
      assert.notOk(table.isConnected);
      assert.equal(document.querySelector('[data-ui-part="table-row"]'), null, 'and takes the rows with it');

      // Longer than the persist debounce, so a timer that survived would write
      // twice and an observer that survived would ask for another page.
      await wait(400);
      assert.equal(writes.length, 1, 'the flushed timer does not fire again');
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
    await ready(table);
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
    await ready(table);

    unmountAll();
    table = /** @type {import('@components/data/ui-table.js').UiTable} */ (mount(markup));
    table.rows = [
      { id: 1, name: 'Ada', team: 'Core', city: 'Rome' },
      { id: 2, name: 'Grace', team: 'Web', city: 'New York' },
      { id: 3, name: 'Linus', team: 'Core', city: 'Helsinki' },
    ];
    await ready(table);

    assert.equal(table.page, 2);
    assert.equal(table.sortKey, 'name');
    assert.equal(table.sortDirection, 'asc');
    assert.sameArray(table.visibleColumns.map((column) => column.key), ['city', 'name']);
    assert.equal(table.columnWidth(present(table.columns[0])), 230);
    assert.equal(table.columnSticky(present(table.columns[2])), 'start');
  });

  /**
   * `table-name` is the older spelling of `state-id`, kept because pages were
   * authored against it. Two attributes for one concept only stay honest while
   * something checks that they still mean the same thing — and that `state-id`
   * wins when a page carries both, which is what the collection's contract promises.
   */
  it('persists under table-name, and lets state-id win over it', async () => {
    const aliased = `
      <ui-table table-name="test-employees" page-size="2" page-sizes="2,5">
        <ui-table-column key="name" label="Name" sortable></ui-table-column>
      </ui-table>
    `;
    let table = /** @type {import('@components/data/ui-table.js').UiTable} */ (mount(aliased));
    table.rows = [{ id: 1, name: 'Ada' }, { id: 2, name: 'Grace' }, { id: 3, name: 'Linus' }];
    await ready(table);
    table.goTo(2);
    table.saveState();
    await ready(table);

    unmountAll();
    table = /** @type {import('@components/data/ui-table.js').UiTable} */ (mount(aliased));
    table.rows = [{ id: 1, name: 'Ada' }, { id: 2, name: 'Grace' }, { id: 3, name: 'Linus' }];
    await ready(table);
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
    await ready(table);
    assert.equal(table.page, 1, 'state-id wins, so the table-name entry is not read');
  });

  /**
   * Holding an arrow key on a resize handle is one config change per keypress, and
   * each one used to be a `JSON.stringify` of the whole column model into storage.
   * `saveState()` stays immediate for a consumer that means now; the internal
   * triggers coalesce.
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
      await ready(table);

      const name = present(table.columns[0]);
      for (let press = 0; press < 5; press += 1) {
        table.resizeFromKeyboard(
          name,
          new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true }),
        );
      }
      await ready(table);
      assert.equal(writes.length, 0, 'a burst must not reach storage while it is still arriving');

      // Unmounting flushes, so the burst is not lost by navigating away.
      unmountAll();
      assert.equal(writes.length, 1);
    } finally {
      configurePreferences();
    }
  });
});
