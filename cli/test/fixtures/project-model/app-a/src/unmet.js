import { NotAnElement } from './plain.js';

export class Unmet extends HTMLElement {}

await defineComponent({
  tag: 'fx-unmet',
  element: Unmet,
  module: import.meta.url,
  template: false,
  uses: [NotAnElement],
});
