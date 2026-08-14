/**
 * A root module that behaves: it defines its element before the module resolves,
 * the way a component module ending in `await defineComponent(...)` does.
 */

export const rootTag = 'startup-fixture-root';

if (customElements.get(rootTag) === undefined) {
  customElements.define(rootTag, class extends HTMLElement {});
}
