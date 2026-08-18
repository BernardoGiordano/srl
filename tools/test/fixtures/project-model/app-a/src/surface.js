// Every way an element declares what markup may write on it, stated once.

// Lit's way: properties, each mapping to an attribute by its own rule.
export class Surface extends HTMLElement {
  static properties = {
    label: { type: String },
    emptyLabel: { type: String, attribute: 'empty-label' },
    collapsed: { type: Boolean, reflect: true, attribute: 'data-collapsed' },
    rows: { attribute: false },
    internal: { state: true },
  };
}

await defineComponent({
  tag: 'fx-surface',
  element: Surface,
  module: import.meta.url,
  template: false,
});

// The platform's way, for an element that is configuration its parent reads rather than a
// component that renders.
export class Metadata extends HTMLElement {
  static observedAttributes = ['key', 'sort-key'];
}

await defineComponent({
  tag: 'fx-metadata',
  element: Metadata,
  module: import.meta.url,
  template: false,
});

// A surface assembled at run time. It works in the browser and no static tool can read it,
// so the model reports it as unknown rather than as empty.
const shared = { type: String };

export class Opaque extends HTMLElement {
  static properties = { title: shared };
}

await defineComponent({
  tag: 'fx-opaque',
  element: Opaque,
  module: import.meta.url,
  template: false,
});
