import { defineComponent, definitionOf } from '@core/elements/component.js';
import { scopeStylesheet } from '@core/elements/style-scope.js';
import { reviseStylesheet } from '@core/elements/stylesheet.js';
import { compileTemplate } from '@core/template/template.js';
import { StyledCard } from '../fixtures/styled-card.js';
import '../fixtures/styled-page.js';
import { assert, mount, present, settled, unmountAll } from '../harness.js';

/**
 * An Element's stylesheet reaches that Element and the markup its own template renders,
 * and nothing else: not what a caller projects into it, not the inside of a nested
 * instance, not the rest of the page. ADR-0119.
 *
 * Asserted on computed styles, because the rewrite is only a means. What a user sees is
 * the cascade, and the cascade is the browser's.
 */

const STYLESHEET = new URL('../fixtures/styled-card.css', import.meta.url).href;
const GREEN = 'rgb(0, 128, 0)';
const NONE = 'rgba(0, 0, 0, 0)';

/**
 * @param {Element} element
 * @param {string} [pseudo]
 */
function computed(element, pseudo) {
  return getComputedStyle(element, pseudo);
}

/** @returns {Promise<HTMLElement>} */
async function page() {
  const element = mount('<styled-page></styled-page>');
  await settled(element);
  return element;
}

describe('an Element stylesheet', () => {
  afterEach(() => {
    unmountAll();
  });

  it('styles the Element and the markup its template renders', async () => {
    const outer = present((await page()).querySelector('.outer'));
    const own = present(outer.querySelector(':scope > h2.title'));

    assert.equal(computed(outer).display, 'block', '`:host` is the element itself');
    assert.equal(computed(own).backgroundColor, GREEN);
    assert.equal(own.getAttribute('data-ui-owner'), 'styled-card');
    assert.equal(computed(present(outer.querySelector('.body')), '::before').content, '"B"');
  });

  it('leaves markup a caller projects into it alone', async () => {
    const element = await page();

    for (const caller of element.querySelectorAll('.caller')) {
      assert.equal(caller.hasAttribute('data-ui-owner'), false);
      assert.equal(
        computed(caller).backgroundColor,
        NONE,
        `${caller.localName} was written by the page and must not match the card's .title`,
      );
    }
  });

  it('answers `:host` for each instance rather than the one around it', async () => {
    const element = await page();
    const outer = present(element.querySelector('.outer > .body'));
    const inner = present(element.querySelector('.inner > .body'));

    assert.equal(computed(outer).paddingTop, '7px');
    assert.equal(computed(inner).paddingTop, '0px', 'the nested card is not flush');
    assert.equal(computed(present(element.querySelector('.inner > h2'))).backgroundColor, GREEN);
  });

  it('sorts under a utility class at the call site', async () => {
    // The order `source/components/style.css` declares, and Tailwind after it.
    const layers = document.createElement('style');
    layers.textContent =
      '@layer properties, theme, base, components, utilities;' +
      '@layer utilities { .probe-inline { display: inline } }';
    document.head.append(layers);
    try {
      const card = mount('<styled-card class="probe-inline"></styled-card>');
      await settled(card);
      assert.equal(computed(card).display, 'inline');
    } finally {
      layers.remove();
    }
  });

  it('records the stylesheet on the definition', () => {
    const definition = definitionOf(StyledCard);
    assert.equal(definition?.styled, true);
    assert.equal(definition?.stylesheetUrl, STYLESHEET);
  });

  it('replaces its rules in place when the stylesheet is revised', async () => {
    const card = mount('<styled-card></styled-card>');
    await settled(card);
    const title = present(card.querySelector('.title'));
    const original = await (await fetch(STYLESHEET)).text();

    try {
      assert.ok(await reviseStylesheet(STYLESHEET, '.title { background-color: rgb(0, 0, 255) }'));
      assert.equal(computed(title).backgroundColor, 'rgb(0, 0, 255)');
      assert.equal(computed(card).display, 'inline', 'a revision replaces every rule');
      assert.equal(card.querySelector('.title'), title, 'the markup is the same nodes');
    } finally {
      await reviseStylesheet(STYLESHEET, original);
    }
    assert.equal(computed(title).backgroundColor, GREEN);
  });

  it('refuses a revision it cannot scope and keeps the rules it had', async () => {
    const card = mount('<styled-card></styled-card>');
    await settled(card);

    await assert.rejects(() => reviseStylesheet(STYLESHEET, '@import "other.css";'), 'uses `@import`');
    assert.equal(computed(present(card.querySelector('.title'))).backgroundColor, GREEN);
  });

  it('has nothing to revise for a stylesheet no Element owns', async () => {
    assert.equal(await reviseStylesheet(new URL('./unowned.css', import.meta.url), ''), false);
  });

  it('refuses a stylesheet on an Element that renders no template', async () => {
    await assert.rejects(
      () =>
        defineComponent({
          tag: 'styled-headless',
          element: class StyledHeadless extends HTMLElement {},
          module: import.meta.url,
          template: false,
          styles: true,
        }),
      'declares `styles` and `template: false`',
    );
    assert.equal(customElements.get('styled-headless'), undefined);
  });

  it('refuses markup that writes ownership itself', () => {
    assert.throws(
      () => compileTemplate('<p data-ui-owner="styled-card"></p>', 'inline markup'),
      'which the template compiler stamps',
    );
  });
});

describe('scopeStylesheet', () => {
  it('filters the element a rule styles, and spells `:host` as the scope root', () => {
    assert.equal(
      scopeStylesheet('x-card', ':host([flush]) .body::before { color: red }', 'inline'),
      '@layer components{@scope (x-card) to (:scope x-card){' +
        ':scope:is([flush]) .body:where([data-ui-owner="x-card"])::before{color: red;}}}',
    );
  });

  it('leaves a nested rule that names its parent to the parent', () => {
    assert.equal(
      scopeStylesheet('x-card', '.a { &:hover { color: red } > .b { color: blue } }', 'inline'),
      '@layer components{@scope (x-card) to (:scope x-card){' +
        '.a:where([data-ui-owner="x-card"]){&:hover{color: red;}> .b:where([data-ui-owner="x-card"]){color: blue;}}}}',
    );
  });

  it('refuses what cannot be scoped to one Element', () => {
    /** @type {Array<[string, string]>} */
    const refused = [
      ['@import "a.css";', 'uses `@import`'],
      ['.a { @apply p-4; }', 'a Tailwind directive'],
      ['@keyframes spin { to { rotate: 1turn } }', 'every stylesheet in the document shares'],
      ['::slotted(p) { color: red }', 'a shadow DOM selector'],
      ['color: red;', 'outside any rule'],
    ];
    for (const [source, reason] of refused) {
      assert.throws(() => scopeStylesheet('x-card', source, 'inline'), reason);
    }
  });
});
