export class Explicit extends HTMLElement {}

await defineComponent({
  tag: 'fx-explicit',
  element: Explicit,
  module: import.meta.url,
  template: './markup/explicit-view.html',
});
