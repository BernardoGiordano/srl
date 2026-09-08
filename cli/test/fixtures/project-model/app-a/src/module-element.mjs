export class ModuleElement extends HTMLElement {}

await defineComponent({
  tag: 'fx-module',
  element: ModuleElement,
  module: import.meta.url,
  template: false,
});
