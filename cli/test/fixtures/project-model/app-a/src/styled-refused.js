export class StyledRefused extends HTMLElement {}

await defineComponent({
  tag: 'fx-styled-refused',
  element: StyledRefused,
  module: import.meta.url,
  styles: true,
});
