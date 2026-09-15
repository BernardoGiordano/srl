export class Styled extends HTMLElement {}

await defineComponent({
  tag: 'fx-styled',
  element: Styled,
  module: import.meta.url,
  styles: true,
});
