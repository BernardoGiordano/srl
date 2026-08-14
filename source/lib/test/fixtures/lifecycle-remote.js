export const contract = 2;
export const rootTag = 'test-lifecycle-remote';

if (customElements.get(rootTag) === undefined) {
  customElements.define(rootTag, class extends HTMLElement {});
}

/** @param {import('@core/remotes/types.js').HostContext} host */
export function mount(host) {
  const element = document.createElement(rootTag);
  /** @type {HTMLElement & { host?: import('@core/remotes/types.js').HostContext }} */ (element).host = host;
  return element;
}
