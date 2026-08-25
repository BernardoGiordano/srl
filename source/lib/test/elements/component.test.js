import { html } from 'lit';
import { defineComponent, definitionOf, resolveTag, tagOf } from '@core/elements/component.js';
import { SignalElement } from '@core/elements/signal-element.js';
import { DerivedHost } from '../fixtures/derived-host.js';
import { assert, mount, present, settled, unmountAll } from '../harness.js';

/**
 * The interface every component module crosses, and the one a route, an outlet
 * target, a remote entry and startup all read back through. Identity used to be
 * stated in four places per component — a static template URL, a `defineComponent`
 * call, a side-effect import, and a tag string in whatever mounted it — and
 * nothing could check that the four agreed.
 */

/** A component with no markup of its own, the `template: false` case. */
class Rendered extends SignalElement {
  render() {
    return html`<span class="in-js">built in JavaScript</span>`;
  }
}
await defineComponent({
  tag: 'definition-rendered',
  element: Rendered,
  module: import.meta.url,
  template: false,
});

/**
 * A component whose markup is not its module's sibling.
 *
 * Exported because cli/checks/template-check.mjs type-checks the fixture template
 * against this class, and it reaches the class through this module's exports.
 */
export class Borrowed extends SignalElement {}
await defineComponent({
  tag: 'definition-borrowed',
  element: Borrowed,
  module: import.meta.url,
  template: '../fixtures/derived-host.html',
  uses: [Rendered],
});

describe('defineComponent', () => {
  afterEach(() => {
    unmountAll();
  });

  it('renders the template it derived from the declaring module', async () => {
    const element = mount('<derived-host></derived-host>');
    await settled(element);

    assert.ok(present(element.querySelector('.derived')), 'the sibling .html must have rendered');
    assert.equal(definitionOf(DerivedHost)?.templateUrl?.endsWith('derived-host.html'), true);
  });

  it('renders in JavaScript when the definition declares no template', async () => {
    const element = mount('<definition-rendered></definition-rendered>');
    await settled(element);

    assert.ok(present(element.querySelector('.in-js')));
    assert.equal(definitionOf(Rendered)?.templateUrl, undefined);
  });

  it('takes a template that is not the module sibling', async () => {
    const element = mount('<definition-borrowed></definition-borrowed>');
    await settled(element);

    assert.ok(present(element.querySelector('.derived')));
  });

  it('records the components a template may name', () => {
    assert.sameArray(
      definitionOf(Borrowed)?.uses.map((used) => used.tag) ?? [],
      ['definition-rendered'],
      'uses is the dependency the template checker reads too',
    );
  });

  it('is idempotent for the same class, so a module served twice is harmless', async () => {
    const first = definitionOf(Rendered);
    const again = await defineComponent({
      tag: 'definition-rendered',
      element: Rendered,
      module: import.meta.url,
      template: false,
    });

    assert.equal(again, first, 'the same declaration must return the same definition');
  });

  it('refuses a tag another class already claimed', async () => {
    await assert.rejects(
      () =>
        defineComponent({
          tag: 'definition-rendered',
          element: class Impostor extends HTMLElement {},
          module: import.meta.url,
          template: false,
        }),
      'is already defined by class Rendered',
    );
  });

  it('refuses a name the parser would reject', async () => {
    await assert.rejects(
      () =>
        defineComponent({
          tag: 'nohyphen',
          element: class Nameless extends HTMLElement {},
          module: import.meta.url,
          template: false,
        }),
      'is not a valid custom element name',
    );
  });

  it('refuses a definition with no declaring module', async () => {
    await assert.rejects(
      () =>
        defineComponent({
          tag: 'definition-anchorless',
          element: class Anchorless extends HTMLElement {},
          module: /** @type {string} */ (/** @type {unknown} */ (undefined)),
          template: false,
        }),
      '`module` must be `import.meta.url`',
    );
  });

  it('refuses `uses` naming a class that never declared itself', async () => {
    await assert.rejects(
      () =>
        defineComponent({
          tag: 'definition-unmet',
          element: class Unmet extends HTMLElement {},
          module: import.meta.url,
          template: false,
          uses: [class Missing extends HTMLElement {}],
        }),
      'which has no component definition',
    );
  });

  it('refuses `uses` given as a tag string', async () => {
    // The point of `uses` is the import: a string names an element without
    // creating the dependency that makes it exist.
    await assert.rejects(
      () =>
        defineComponent({
          tag: 'definition-stringly',
          element: class Stringly extends HTMLElement {},
          module: import.meta.url,
          template: false,
          uses: ['definition-rendered'],
        }),
      'is a tag string',
    );
  });

  it('does not register an element whose declaration failed', () => {
    assert.equal(customElements.get('definition-unmet'), undefined);
    assert.equal(customElements.get('definition-stringly'), undefined);
  });
});

describe('tagOf', () => {
  it('reads a tag from a class, a definition or a tag', () => {
    assert.equal(tagOf(Rendered), 'definition-rendered');
    assert.equal(tagOf(present(definitionOf(Rendered))), 'definition-rendered');
    assert.equal(tagOf('definition-rendered'), 'definition-rendered');
  });

  it('refuses a class with no definition, naming what to do about it', () => {
    class Undeclared extends HTMLElement {}
    assert.throws(() => tagOf(Undeclared), 'class Undeclared has no component definition');
  });
});

describe('resolveTag', () => {
  it('names nothing for a value that is not a component', async () => {
    // What a `load` that resolves a module namespace hands back. Legal: the
    // caller's own `tag` names what to mount in that case.
    const namespace = await import('../fixtures/derived-host.js');

    assert.equal(resolveTag(namespace), undefined);
    assert.equal(resolveTag(undefined), undefined);
    assert.equal(resolveTag(namespace.DerivedHost), 'derived-host');
  });
});
