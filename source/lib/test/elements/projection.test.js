import { html } from 'lit';
import { signal } from '@core/foundation/reactive.js';
import { SignalElement } from '@core/elements/signal-element.js';
import { assert, mount, present, settled, unmountAll } from '../harness.js';

const tick = signal(0);

class SlottedCard extends SignalElement {
  render() {
    return html`
      <section>
        <header><x-content name="header"></x-content></header>
        <div class="body"><x-content></x-content></div>
        <span class="tick">${tick.value}</span>
      </section>
    `;
  }
}
customElements.define('slotted-card', SlottedCard);

/**
 * A caller whose projected content is a lit binding rather than a fixed element —
 * which is what every `*if`, `*else` and `*for` in an application's markup
 * compiles to.
 */
const branch = signal(false);
const rows = signal(/** @type {readonly string[]} */ (['a']));

class DynamicCaller extends SignalElement {
  render() {
    return html`
      <slotted-card>
        <b slot="header">Header</b>
        ${branch.value ? html`<ul class="second"></ul>` : html`<p class="first"></p>`}
        ${rows.value.map((row) => html`<span class="row">${row}</span>`)}
      </slotted-card>
    `;
  }
}
customElements.define('dynamic-caller', DynamicCaller);

class NestingCard extends SignalElement {
  render() {
    return html`
      <div class="outer">
        <x-content name="outer"></x-content>
        <slotted-card>
          <b slot="header">Inner header</b>
          <i>Inner body</i>
        </slotted-card>
      </div>
    `;
  }
}
customElements.define('nesting-card', NestingCard);

describe('light-DOM content projection', () => {
  afterEach(() => {
    tick.value = 0;
    branch.value = false;
    rows.value = ['a'];
    unmountAll();
  });

  it('projects default and named content', async () => {
    const element = mount(`
      <slotted-card>
        <h2 slot="header">Title</h2>
        <p>Body text</p>
      </slotted-card>
    `);
    await settled(element);

    assert.equal(element.querySelector('header h2')?.textContent, 'Title');
    assert.equal(element.querySelector('.body p')?.textContent, 'Body text');
  });

  it('drops whitespace-only text so empty markers stay detectable', async () => {
    const element = mount('<slotted-card>\n\n   \n</slotted-card>');
    await settled(element);

    const marker = element.querySelector('x-content:not([name])');
    assert.equal(marker?.childNodes.length, 0, 'whitespace must not count as content');
  });

  it('keeps the same projected node identity across re-renders', async () => {
    const element = mount('<slotted-card><p>Body</p></slotted-card>');
    await settled(element);

    const before = element.querySelector('.body p');
    assert.ok(before);

    tick.value = 1;
    await settled(element);

    assert.equal(element.querySelector('.tick')?.textContent, '1', 'template must have re-rendered');
    assert.equal(
      element.querySelector('.body p'),
      before,
      'projected nodes must be moved, never cloned or recreated',
    );
  });

  it('does not let an outer component fill a nested component markers', async () => {
    const element = mount(`
      <nesting-card>
        <em slot="outer">Outer content</em>
      </nesting-card>
    `);
    await settled(element);
    const inner = present(element.querySelector('slotted-card'));
    await settled(inner);

    assert.equal(
      element.querySelector('.outer > x-content[name="outer"] em')?.textContent,
      'Outer content',
    );
    assert.equal(inner.querySelector('header b')?.textContent, 'Inner header');
    assert.equal(inner.querySelector('.body i')?.textContent, 'Inner body');
  });

  it('keeps a caller replacing its content inside the marker', async () => {
    const element = mount('<dynamic-caller></dynamic-caller>');
    await settled(element);
    const card = present(element.querySelector('slotted-card'));
    await settled(card);

    assert.ok(card.querySelector('.body .first'), 'first branch must be projected');

    branch.value = true;
    await settled(element);
    await settled(card);

    // The caller's binding is a range between two anchor nodes. Leave those
    // anchors behind in the host and this update writes outside the component:
    // the old branch is stranded inside it and the new one appears next to it.
    assert.notOk(card.querySelector('.first'), 'the replaced branch must be gone');
    assert.ok(card.querySelector('.body .second'), 'the new branch must be inside the marker');
  });

  it('keeps content a caller appends inside the marker', async () => {
    const element = mount('<dynamic-caller></dynamic-caller>');
    await settled(element);
    const card = present(element.querySelector('slotted-card'));
    await settled(card);

    rows.value = ['a', 'b', 'c'];
    await settled(element);
    await settled(card);

    assert.equal(card.querySelectorAll('.body .row').length, 3, 'every row must be projected');
    assert.equal(card.querySelector('header b')?.textContent, 'Header', 'named content survives');
  });

  it('makes markers layout-transparent', async () => {
    const element = mount('<slotted-card><p>Body</p></slotted-card>');
    await settled(element);

    // An inline wrapper here would silently break every flex and grid utility
    // applied to the parent.
    const marker = present(element.querySelector('x-content'));
    assert.equal(getComputedStyle(marker).display, 'contents');
  });

  it('lets a layered utility override the marker default', async () => {
    // Tailwind emits every utility inside `@layer utilities`, and a layered
    // declaration loses to an unlayered one no matter how specific it is. So the
    // marker default has to be layered too, and declared first — otherwise
    // `class="block"` on a marker or a route outlet is silently ignored.
    const utilities = document.createElement('style');
    utilities.textContent = '@layer utilities{.block{display:block}}';
    document.head.append(utilities);

    try {
      const element = mount('<slotted-card><p>Body</p></slotted-card>');
      await settled(element);

      const marker = present(element.querySelector('x-content:not([name])'));
      marker.className = 'block';
      assert.equal(getComputedStyle(marker).display, 'block');
    } finally {
      utilities.remove();
    }
  });
});
