/**
 * Default styles for the framework's marker elements, `<x-content>` and
 * `<x-route-outlet>`.
 *
 * Both need `display: contents`, and a utility an application puts on them must
 * still win. An unlayered rule beats every layered one, so the defaults live in a
 * cascade layer of their own. ADR-0119.
 *
 * Layers sort in the order their names first appear. The style element is prepended
 * to `<head>`, so Tailwind's layers come later and win, whether Tailwind injects
 * them before or after this module runs.
 */

const LAYER = 'ui-element-defaults';
const STYLE_ATTR = 'data-ui-element-defaults';

/**
 * Register a low-priority default rule for a marker tag.
 *
 * Idempotent per tag. All callers share one `<style>`, which keeps the layer
 * declared once, at the front.
 *
 * @param {string} tag
 * @param {string} declarations CSS declarations, without the surrounding braces.
 */
export function defineElementDefault(tag, declarations) {
  const existing = document.querySelector(`style[${STYLE_ATTR}]`);
  const style = existing ?? document.createElement('style');

  if (existing === null) {
    style.setAttribute(STYLE_ATTR, '');
    // Prepended, so this layer sorts before Tailwind's.
    document.head.prepend(style);
  }

  const rule = `${tag}{${declarations}}`;
  if (style.textContent?.includes(rule) === true) return;

  style.textContent = `${style.textContent ?? ''}@layer ${LAYER}{${rule}}`;
}
