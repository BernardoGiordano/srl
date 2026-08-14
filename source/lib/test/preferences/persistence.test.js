import { assert } from '../harness.js';
import {
  preferenceKey,
  configurePreferences,
  createMemoryStorage,
  loadPreference,
  migrateLegacyKey,
  removePreference,
  savePreference,
} from '@core/preferences/persistence.js';

/**
 * The one interface every non-auth UI preference crosses.
 *
 * Everything here is asserted through the module rather than against a storage key,
 * because the key layout is implementation: the table, the filters, the sidebar, the
 * theme and the locale are all supposed to be replaceable by one
 * `configurePreferences` call, and a test that reads `localStorage` itself would
 * still pass on the day one of them stopped honouring it.
 */

describe('component state', () => {
  /** @type {ReturnType<typeof createMemoryStorage>} */
  let storage;

  beforeEach(() => {
    storage = createMemoryStorage();
    configurePreferences({ prefix: 'test.state', storage });
  });

  afterEach(() => configurePreferences());

  it('isolates versioned state by component and identifier', () => {
    assert.ok(savePreference('ui-table', 'employees/current', { page: 3 }));
    assert.equal(
      /** @type {{ page?: number }} */ (
        loadPreference('ui-table', 'employees/current')
      )?.page,
      3,
    );
    assert.equal(loadPreference('ui-table', 'contracts'), undefined);
    assert.ok(preferenceKey('ui-table', 'employees/current').endsWith('employees%2Fcurrent'));
  });

  it('supports schema migration and ignores broken stored data', () => {
    savePreference('ui-table', 'employees', { oldPage: 4 }, { schemaVersion: 1 });
    const migrated = loadPreference('ui-table', 'employees', {
      schemaVersion: 2,
      migrate: (state, version) => ({
        page:
          version === 1 && state !== null && typeof state === 'object'
            ? Number(/** @type {Record<string, unknown>} */ (state).oldPage)
            : 1,
      }),
    });
    assert.equal(migrated?.page, 4);

    storage.setItem(preferenceKey('ui-table', 'broken'), '{');
    assert.equal(loadPreference('ui-table', 'broken'), undefined);
  });

  it('removes only requested component state', () => {
    savePreference('ui-table', 'one', { page: 1 });
    savePreference('ui-table', 'two', { page: 2 });
    assert.ok(removePreference('ui-table', 'one'));
    assert.equal(loadPreference('ui-table', 'one'), undefined);
    assert.equal(
      /** @type {{ page?: number }} */ (loadPreference('ui-table', 'two'))?.page,
      2,
    );
  });

  /**
   * The whole failure policy in one case, because every caller depends on it and none
   * of them may implement its own: a store that throws on every call — Safari in a
   * blocked third-party frame, storage disabled by enterprise policy — has to read as
   * "no state" and write as "did not persist", never as an exception on a render path.
   */
  it('treats a storage that throws as missing state rather than an error', () => {
    configurePreferences({
      prefix: 'test.state',
      storage: {
        getItem: () => {
          throw new DOMException('blocked', 'SecurityError');
        },
        setItem: () => {
          throw new DOMException('blocked', 'SecurityError');
        },
        removeItem: () => {
          throw new DOMException('blocked', 'SecurityError');
        },
      },
    });

    assert.equal(loadPreference('ui-table', 'employees'), undefined);
    assert.equal(savePreference('ui-table', 'employees', { page: 1 }), false);
    assert.equal(removePreference('ui-table', 'employees'), false);
    assert.equal(
      migrateLegacyKey('theme', 'ui.theme', 'ui.theme', { accept: (raw) => raw }),
      undefined,
    );
  });

  it('reports state that cannot be serialised as not persisted', () => {
    /** @type {Record<string, unknown>} */
    const cyclic = {};
    cyclic.self = cyclic;
    assert.equal(savePreference('ui-table', 'cyclic', cyclic), false);
    assert.equal(loadPreference('ui-table', 'cyclic'), undefined);
  });

  /**
   * Theme and locale each owned a bare storage key before this module owned them, so
   * the upgrade has to adopt what is already there. Once.
   */
  it('adopts a legacy raw key once and then forgets it', () => {
    storage.setItem('ui.theme', 'forest');

    assert.equal(
      migrateLegacyKey('theme', 'ui.theme', 'ui.theme', { accept: (raw) => raw }),
      'forest',
    );
    assert.equal(storage.getItem('ui.theme'), null, 'the legacy key is not read twice');
    assert.equal(loadPreference('theme', 'ui.theme'), 'forest', 'stored as an envelope');

    // Second call: the envelope answers, and there is no legacy value left to weigh.
    assert.equal(
      migrateLegacyKey('theme', 'ui.theme', 'ui.theme', {
        accept: () => {
          throw new Error('accept must not be consulted once a preference exists');
        },
      }),
      'forest',
    );
  });

  it('discards a legacy value the caller declines, and does not keep asking', () => {
    storage.setItem('ui.theme', 'a-theme-nobody-registers');

    assert.equal(
      migrateLegacyKey('theme', 'ui.theme', 'ui.theme', { accept: () => undefined }),
      undefined,
    );
    assert.equal(storage.getItem('ui.theme'), null);
    assert.equal(loadPreference('theme', 'ui.theme'), undefined, 'nothing was adopted');
  });

  it('keeps an existing preference when a legacy key is also present', () => {
    savePreference('locale', 'ui.locale', 'it');
    storage.setItem('ui.locale', 'ar');

    assert.equal(
      migrateLegacyKey('locale', 'ui.locale', 'ui.locale', { accept: (raw) => raw }),
      'it',
      'the current preference wins over a leftover key',
    );
    assert.equal(storage.getItem('ui.locale'), null, 'and the leftover is cleaned up anyway');
  });

  it('isolates one suite from another', () => {
    savePreference('ui-table', 'employees', { page: 9 });
    configurePreferences({ prefix: 'test.state', storage: createMemoryStorage() });
    assert.equal(loadPreference('ui-table', 'employees'), undefined);
  });
});
