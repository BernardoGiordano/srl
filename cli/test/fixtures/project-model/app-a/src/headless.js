export class Headless extends HTMLElement {}

await defineComponent({
  tag: 'fx-headless',
  element: Headless,
  module: import.meta.url,
  template: false,
});
