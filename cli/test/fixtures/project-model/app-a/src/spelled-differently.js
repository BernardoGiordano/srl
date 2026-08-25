// The same module as ./child.js, reached by a longer route. `uses` must resolve to the
// one definition, not to nothing.
import { Child } from '../src/./child.js';

export class Spelled extends HTMLElement {}

await defineComponent({
  tag: 'fx-spelled',
  element: Spelled,
  module: import.meta.url,
  template: false,
  uses: [Child],
});
