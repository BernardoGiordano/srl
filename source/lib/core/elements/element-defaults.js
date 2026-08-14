/**
 * Document-level default styling for the framework's own marker elements.
 *
 * Two of them — `<x-content>` and `<x-route-outlet>` — must be `display: contents`
 * so they vanish from layout, and both must lose the moment an application puts a
 * display or spacing utility on them. Getting the second half right is the reason
 * this module exists.
 *
 * The defaults go in a cascade layer of their own, which is what an application's
 * utility class needs to outrank them — specificity alone does not do it, because
 * an unlayered rule beats every layered one whatever its specificity. ADR-0001.
 *
 * The layer has to sort before Tailwind's, and layer order is the order in which
 * layer names are first seen in document order. Hence prepended to `<head>` rather
 * than appended: whatever Tailwind has already injected — or injects later, as the
 * browser JIT build does — is then downstream of this name and wins.
 */

const LAYER = 'ui-element-defaults';
const STYLE_ATTR = 'data-ui-element-defaults';

/**
 * Register a low-priority default rule for one of the framework's marker tags.
 *
 * Idempotent per tag, so a module re-evaluated under a second import map adds
 * nothing. Every caller shares one `<style>`, which is what keeps the layer
 * declared exactly once and at the front.
 *
 * @param {string} tag
 * @param {string} declarations CSS declarations, without the surrounding braces.
 */
export function defineElementDefault(tag, declarations) {
  const existing = document.querySelector(`style[${STYLE_ATTR}]`);
  const style = existing ?? document.createElement('style');

  if (existing === null) {
    style.setAttribute(STYLE_ATTR, '');
    // Prepended, not appended: see the note above on layer ordering.
    document.head.prepend(style);
  }

  const rule = `${tag}{${declarations}}`;
  if (style.textContent?.includes(rule) === true) return;

  style.textContent = `${style.textContent ?? ''}@layer ${LAYER}{${rule}}`;
}
