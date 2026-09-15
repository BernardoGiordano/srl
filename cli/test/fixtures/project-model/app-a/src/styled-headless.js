export class StyledHeadless extends HTMLElement {}

await defineComponent({
  tag: 'fx-styled-headless',
  element: StyledHeadless,
  module: import.meta.url,
  template: false,
  styles: true,
});
