export class StyledMissing extends HTMLElement {}

await defineComponent({
  tag: 'fx-styled-missing',
  element: StyledMissing,
  module: import.meta.url,
  styles: true,
});
