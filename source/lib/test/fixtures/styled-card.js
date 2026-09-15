import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';

/**
 * A component with a stylesheet of its own. A fixture rather than a class inside the
 * test file, because the stylesheet is the module's sibling and is only a real test
 * when it is a file on disk.
 */
export class StyledCard extends SignalElement {
  static properties = {
    flush: { type: Boolean, reflect: true },
  };

  flush = false;
}

await defineComponent({
  tag: 'styled-card',
  element: StyledCard,
  module: import.meta.url,
  styles: true,
});
