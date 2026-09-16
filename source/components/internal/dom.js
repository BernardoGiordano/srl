/**
 * The three DOM conventions every element in this collection needed a copy of.
 *
 * None of them is interesting on its own. Each is needed in four to six modules,
 * which is what makes them worth a module of their own. A convention restated per
 * element is a convention that can disagree with itself.
 *
 * Like `filter-descriptor.js`, this imports only `lit`'s `nothing` sentinel and
 * touches no element, so it is testable without a render pass.
 */

import { nothing } from 'lit';

/**
 * An attribute value that disappears when it is empty.
 *
 * `nothing` removes the attribute, where an empty string would leave
 * `aria-label=""` and rename the element to nothing at all. That reads worse to a
 * screen reader than no label, because it also suppresses the fallback to the
 * element's own content.
 *
 * Components expose `labelAttr` rather than `ariaLabel` for a related reason.
 * `ariaLabel` is a real property of every `Element` through ARIAMixin, and a
 * component's template surface shares its namespace with the DOM, so the two
 * collide. tsc reports it.
 *
 * @param {string} value
 * @returns {string | typeof nothing}
 */
export function optionalAttr(value) {
  return value === '' ? nothing : value;
}

/**
 * Is this element laid out right-to-left?
 *
 * Read from computed style rather than a property, because direction is inherited
 * and is normally set once on `<html>`. Read at the moment it is needed rather
 * than cached, because a language switch changes it without recreating anything.
 *
 * @param {Element} element
 * @returns {boolean}
 */
export function isRtl(element) {
  return getComputedStyle(element).direction === 'rtl';
}

/**
 * `-1` in right-to-left and `1` otherwise. It turns "the user pressed ArrowRight"
 * into "the column moves later in the order".
 *
 * Keyboard reordering, keyboard resizing and pointer resizing all need it, and as
 * three separate expressions each gets it wrong in its own way.
 *
 * @param {Element} element
 * @returns {-1 | 1}
 */
export function directionSign(element) {
  return isRtl(element) ? -1 : 1;
}

/** One counter for the whole collection, so no two ids can collide. */
let nextId = 0;

/**
 * A unique id for `aria-controls`, `aria-activedescendant` and friends.
 *
 * A counter rather than `crypto.randomUUID()`, because these ids appear in the DOM
 * while debugging, are never persisted, and `ui-menu-3` reads better than a UUID.
 * One counter here, rather than one per module, is also one prefix table rather
 * than three kept unique by hand.
 *
 * @param {string} prefix
 * @returns {string}
 */
export function nextElementId(prefix) {
  nextId += 1;
  return `${prefix}-${String(nextId)}`;
}
