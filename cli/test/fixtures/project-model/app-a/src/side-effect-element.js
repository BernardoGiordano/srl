// A plain custom element: it owns its own children, so it cannot be a srl component
// whose template would wipe them on every render. `customElements.define` rather than
// `defineComponent`, which means no component definition exists for this class and a
// `uses` entry naming it throws.
export class SideEffectPlain extends HTMLElement {
  static observedAttributes = ['label'];
}

customElements.define('fx-plain', SideEffectPlain);
