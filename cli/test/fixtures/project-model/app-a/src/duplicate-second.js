export class Second extends HTMLElement {}

await defineComponent({
  tag: 'fx-duplicate',
  element: Second,
  module: import.meta.url,
  template: false,
});
