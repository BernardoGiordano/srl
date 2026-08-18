export class Child extends HTMLElement {
  static properties = { label: { type: String }, rows: { attribute: false } };
}

await defineComponent({ tag: 'fx-child', element: Child, module: import.meta.url });
