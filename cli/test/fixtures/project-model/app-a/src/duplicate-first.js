export class First extends HTMLElement {}

await defineComponent({
  tag: 'fx-duplicate',
  element: First,
  module: import.meta.url,
  template: false,
});
