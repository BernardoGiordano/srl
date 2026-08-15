import { assert, mount, present, settled, unmountAll } from '../../../lib/test/harness.js';
import { configurePreferences, createMemoryStorage } from '@core/preferences/persistence.js';
import { configureI18n, setLocale } from '@core/localization/i18n.js';
import { STANDARD_TEXT, configureCollectionText, standardText } from '@components/internal/text.js';
import {
  STANDARD_TEXT_FIXTURE,
  restoreStandardText,
  standardTextKeys,
  useStandardText,
} from '../standard-text.js';
import '@components/data/ui-table.js';
import '@components/data/ui-dynamic-filter.js';

/**
 * Standard text: the interface that replaced forty label properties.
 *
 * The claims worth holding on to are that an element resolves what it says about
 * itself, that a locale change re-resolves it in place, that a caller can still
 * own the wording that names its data, and that a missing message renders its key
 * rather than silently English prose.
 */

/** The locale fixtures, built by hand: `new URL` percent-encodes `{locale}`. */
const FIXTURES = `${new URL('../fixtures/text/', import.meta.url).href}{locale}.json`;

/** @param {Element} element */
async function ready(element) {
  await settled(element);
  for (const child of element.querySelectorAll('*')) {
    const updatable = /** @type {{ updateComplete?: Promise<unknown> }} */ (child);
    if (updatable.updateComplete !== undefined) await updatable.updateComplete;
  }
  await settled(element);
}

/** @param {Element} element */
function pointerDown(element) {
  element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
}

/**
 * A filter with one range preset, whose option label is built from the two words
 * in `ui.filter.*` and therefore shows what the resolver answered.
 *
 * @returns {import('@components/data/ui-dynamic-filter.js').UiDynamicFilter}
 */
function rangeFilterFixture() {
  const filter = /** @type {import('@components/data/ui-dynamic-filter.js').UiDynamicFilter} */ (
    mount('<ui-dynamic-filter name="text-filter" locale="en-GB"></ui-dynamic-filter>')
  );
  filter.rules = [
    {
      ref: 'created',
      type: 'daterange',
      label: 'Custom',
      presets: [{ label: 'That week', value: '2026-03-03 to 2026-03-08' }],
    },
  ];
  return filter;
}

/** @param {Element} filter */
function optionLabel(filter) {
  return present(filter.querySelector('[data-ui-part="combobox-option"]')).textContent?.trim();
}

/** @returns {import('@components/data/ui-table.js').UiTable} */
function tableFixture() {
  return mount(`
    <ui-table page-size="2" caption="Employees">
      <ui-table-column key="name" label="Name" sortable></ui-table-column>
    </ui-table>
  `);
}

describe('collection standard text', () => {
  beforeEach(() => {
    configurePreferences({ storage: createMemoryStorage() });
    useStandardText();
  });

  afterEach(() => {
    unmountAll();
    restoreStandardText();
    configurePreferences();
  });

  it('renders the key itself when a message is missing', async () => {
    configureCollectionText({ resolve: () => undefined });

    // Every standard string, so that no element can be carrying an English
    // fallback of its own: with a resolver that answers nothing, each one is its
    // own key.
    for (const [namespace, { names }] of Object.entries(STANDARD_TEXT)) {
      for (const name of names) {
        const key = `ui.${namespace}.${name}`;
        assert.equal(
          standardText(/** @type {keyof typeof STANDARD_TEXT} */ (namespace), name),
          key,
          `${key} must render as itself, not as English`,
        );
      }
    }

    // And in the DOM, not only through the module interface.
    const table = tableFixture();
    table.rows = [];
    await ready(table);
    assert.equal(
      present(table.querySelector('[data-ui-part="table-empty"]')).textContent?.trim(),
      'ui.table.empty',
    );
  });

  it('supplies every standard label from the configured resolver', () => {
    for (const key of standardTextKeys()) {
      const [, namespace, name] = key.split('.');
      assert.equal(
        standardText(
          /** @type {keyof typeof STANDARD_TEXT} */ (present(namespace)),
          present(name),
        ),
        STANDARD_TEXT_FIXTURE[/** @type {keyof typeof STANDARD_TEXT_FIXTURE} */ (key)],
        key,
      );
    }
  });

  it('resolves what an element says about itself, in the DOM', async () => {
    const table = tableFixture();
    table.rows = [{ id: 1, name: 'Ada' }];
    await ready(table);

    assert.equal(
      present(table.querySelector('[data-ui-part="table-previous"]')).getAttribute('aria-label'),
      'Previous',
    );
    assert.equal(
      present(table.querySelector('[data-ui-part="table-pagination"] label span')).textContent?.trim(),
      'Rows',
    );
    assert.equal(
      present(table.querySelector('[data-ui-part="table-sort"]')).getAttribute('aria-label'),
      'Sort ascending by Name',
    );
  });

  it('leaves the wording that names the data to the caller', async () => {
    const table = tableFixture();
    table.rows = [];
    await ready(table);

    // The caption and the column label are the screen's, and no resolver is
    // consulted for either.
    assert.equal(present(table.querySelector('caption')).textContent?.trim(), 'Employees');
    assert.equal(
      present(table.querySelector('[data-ui-part="table-sort"] span')).textContent?.trim(),
      'Name',
    );
    assert.equal(
      present(table.querySelector('[data-ui-part="table-empty"]')).textContent?.trim(),
      'Empty',
    );

    table.emptyLabel = 'No employees yet';
    await ready(table);
    assert.equal(
      present(table.querySelector('[data-ui-part="table-empty"]')).textContent?.trim(),
      'No employees yet',
      'an explicit label wins where one is supported',
    );
  });

  it('treats an empty message as deliberate rather than missing', async () => {
    // `ui.filter.from` and `ui.filter.to` emptied is how a bundle asks for
    // `3/3 – 3/7`. Were the empty string read as a missing message, the two words
    // would come back as their own keys and the range would say so.
    useStandardText({ 'ui.filter.from': '', 'ui.filter.to': '' });

    const filter = rangeFilterFixture();
    await ready(filter);
    pointerDown(present(filter.querySelector('[data-ui-part="combobox-control"]')));
    await ready(filter);

    assert.equal(optionLabel(filter), 'That week 03/03/2026 – 07/03/2026');

    useStandardText();
    await ready(filter);
    assert.equal(optionLabel(filter), 'That week from 03/03/2026 to 07/03/2026');
  });

  it('re-resolves a mounted element when the resolver is replaced', async () => {
    const table = tableFixture();
    table.rows = [{ id: 1, name: 'Ada' }];
    await ready(table);

    const previous = present(table.querySelector('[data-ui-part="table-previous"]'));
    assert.equal(previous.getAttribute('aria-label'), 'Previous');

    useStandardText({ 'ui.table.previous': 'Back' });
    await ready(table);

    assert.equal(previous.getAttribute('aria-label'), 'Back');
    assert.ok(previous.isConnected, 'the button was patched, not replaced');
  });

  it('follows a locale change through the default resolver, in place', async () => {
    // The default resolver is the message table, and this is the only case that
    // exercises it: everything else here injects one.
    restoreStandardText();
    await configureI18n({
      defaultLocale: 'en',
      supportedLocales: ['en', 'it'],
      bundles: [FIXTURES],
    });
    // Explicitly, because `configureI18n` negotiates against `navigator.languages`
    // and a machine set to Italian would otherwise start this case in Italian.
    await setLocale('en');

    const table = tableFixture();
    table.rows = [{ id: 1, name: 'Ada' }];
    await ready(table);

    const previous = present(table.querySelector('[data-ui-part="table-previous"]'));
    assert.equal(previous.getAttribute('aria-label'), 'Previous page');

    await setLocale('it');
    await ready(table);

    assert.equal(previous.getAttribute('aria-label'), 'Pagina precedente');
    assert.ok(previous.isConnected, 'the same node, re-resolved');
    assert.equal(
      present(table.querySelector('[data-ui-part="table-pagination"] nav')).getAttribute(
        'aria-label',
      ),
      'Paginazione tabella',
    );

    await setLocale('en');
  });

  it('renders the key for a name the collection does not declare', () => {
    // A typo resolves to itself and never reaches the application's bundle, so
    // the missing string is visible in the page rather than plausible-looking
    // English.
    assert.equal(standardText('table', 'previuos'), 'ui.table.previuos');
  });
});
