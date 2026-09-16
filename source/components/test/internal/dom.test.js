import { nothing } from 'lit';
import { assert, mount, unmountAll } from '../../../lib/test/harness.js';
import { directionSign, isRtl, nextElementId, optionalAttr } from '@components/internal/dom.js';

/**
 * Three one-line conventions that four to six elements each depend on. They are
 * here because a convention restated per element is a convention that can disagree
 * with itself, and because `optionalAttr` and `nextElementId` need no element at
 * all to check.
 */

describe('dom conventions', () => {
  afterEach(() => {
    unmountAll();
  });

  it('removes an empty attribute rather than emptying it', () => {
    // `aria-label=""` renames an element to nothing and suppresses the fallback
    // to its own content, which is worse for a screen reader than having no
    // `aria-label` at all.
    assert.equal(optionalAttr(''), nothing);
    assert.equal(optionalAttr('Collapse the menu'), 'Collapse the menu');
  });

  it('gives every caller a distinct id, whatever the prefix', () => {
    const first = nextElementId('ui-menu');
    const second = nextElementId('ui-menu');
    const other = nextElementId('ui-combobox');

    assert.ok(first !== second, `${first} must not repeat`);
    assert.ok(first.startsWith('ui-menu-'), first);
    assert.ok(other.startsWith('ui-combobox-'), other);
    // One counter for the whole collection, so a shared prefix is not what keeps
    // these apart. Two modules that pick the same prefix still cannot collide.
    assert.ok(nextElementId('same') !== nextElementId('same'));
  });

  it('reads direction from computed style, so it follows an inherited dir', () => {
    const host = mount('<div><span>inside</span></div>');
    const inner = /** @type {HTMLElement} */ (host.firstElementChild);

    assert.notOk(isRtl(inner));
    assert.equal(directionSign(inner), 1);

    // Set on the ancestor rather than the element, because direction is
    // inherited. That is why this is read from computed style and not from a
    // property.
    host.setAttribute('dir', 'rtl');
    assert.ok(isRtl(inner), 'an inherited dir must count');
    assert.equal(directionSign(inner), -1);
  });
});
