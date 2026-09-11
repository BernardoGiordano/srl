import { reviseComponentModule } from '@core/elements/component.js';
import { recordUpdates } from '@core/diagnostics/updates.js';
import { assert, mount, present, settled, unmountAll } from '../harness.js';

/** @import { ElementUpdate, UpdateRecord } from '@core/diagnostics/types.js' */

/**
 * Replacing a component's JavaScript in a page that is already running it.
 *
 * `customElements.define` is permanent, so the tag keeps the class it was
 * registered with and the edit moves into that class instead. What each test here
 * is really about is the line between the two: a method body is behaviour and can
 * move, while a field, a base class and a reactive property are identity and cannot
 * — and identity is checked before anything is written, so a refused edit leaves the
 * page exactly as it was. ADR-0113.
 *
 * The subject is a real module, imported twice. `revisable-component.js` branches on
 * the revision query the replacement path adds, which is what makes the second
 * evaluation a genuinely different class rather than the same bytes again.
 */

const FIXTURE = new URL('../fixtures/revisable-component.js', import.meta.url).href;

/**
 * Import one case of the fixture and mount it.
 *
 * @param {string} shape
 * @returns {Promise<{ element: HTMLElement, module: string, tag: string }>}
 */
async function running(shape) {
  const module = `${FIXTURE}?case=${shape}`;
  await import(module);
  const tag = `revisable-${shape}`;
  const element = mount(`<${tag}></${tag}>`);
  await settled(element);
  return { element, module, tag };
}

/**
 * @param {ParentNode} element
 * @param {string} selector
 * @returns {string}
 */
function text(element, selector) {
  return present(element.querySelector(selector)).textContent ?? '';
}

describe('component revisions', () => {
  afterEach(() => {
    unmountAll();
  });

  it('runs the edited class body in the host that was already running the old one', async () => {
    const { element, module, tag } = await running('method');
    assert.equal(text(element, '.label'), 'before');

    /** @type {{ greeting: string }} */ (/** @type {unknown} */ (element)).greeting = 'bonjour';
    assert.ok(await reviseComponentModule(module));
    await settled(element);

    assert.equal(text(element, '.label'), 'after');
    assert.equal(
      element,
      document.querySelector(tag),
      'the host must be the same element, not a replacement',
    );
    assert.equal(
      text(element, '.greeting'),
      'bonjour',
      'the fields the old class installed are the reason not to reload',
    );
  });

  it('runs it in an element created after the edit as well', async () => {
    const { element, module, tag } = await running('method');
    assert.ok(await reviseComponentModule(module));
    await settled(element);

    const later = document.createElement(tag);
    element.after(later);
    await settled(later);

    assert.equal(
      text(later, '.label'),
      'after',
      'the registry still builds the registered class, so the edit has to live on it',
    );
    later.remove();
  });

  it('reports that the definition is why the element rendered', async () => {
    const { element, module, tag } = await running('method');

    const stop = recordUpdates();
    await reviseComponentModule(module);
    await settled(element);
    const report = stop();

    const causes = report.records
      .filter(
        /** @returns {record is ElementUpdate} */
        (/** @type {UpdateRecord} */ record) => record.kind === 'element' && record.tag === tag,
      )
      .map((record) => record.cause);
    assert.sameArray(causes, ['definition'], 'ADR-0109: the path that knew names the cause');
  });

  it('refuses an edit that keeps state in a private field', async () => {
    const { element, module } = await running('private');

    await assert.rejects(() => reviseComponentModule(module), 'private fields');
    await settled(element);
    assert.equal(text(element, '.label'), 'before', 'a refusal must change nothing');
  });

  it('refuses an edit that adds a field', async () => {
    const { element, module } = await running('field');

    await assert.rejects(() => reviseComponentModule(module), 'its fields changed');
    await settled(element);
    assert.equal(text(element, '.label'), 'before');
  });

  it('refuses an edit that changes what a field is initialised to', async () => {
    const { element, module } = await running('initialiser');

    await assert.rejects(() => reviseComponentModule(module), 'its fields changed');
    await settled(element);
    assert.equal(
      text(element, '.greeting'),
      'hello',
      'the old value would stand for the rest of the session, with nothing to say so',
    );
  });

  it('refuses an edit that declares a different reactive property', async () => {
    const { element, module } = await running('property');

    await assert.rejects(() => reviseComponentModule(module), 'reactive properties');
    await settled(element);
    assert.equal(text(element, '.label'), 'before');
  });

  it('refuses an edit that changes the base class', async () => {
    const { element, module } = await running('base');

    await assert.rejects(() => reviseComponentModule(module), 'extends a different class');
    await settled(element);
    assert.equal(text(element, '.label'), 'before');
  });

  it('answers false for a module that declares no component', async () => {
    assert.notOk(await reviseComponentModule('/lib/test/fixtures/not-a-component.js'));
  });
});
