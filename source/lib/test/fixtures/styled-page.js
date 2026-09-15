import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { StyledCard } from './styled-card.js';

/**
 * An unstyled caller of `<styled-card>`, which projects markup of its own into the card
 * and into a second card nested inside the first.
 */
export class StyledPage extends SignalElement {}

await defineComponent({
  tag: 'styled-page',
  element: StyledPage,
  module: import.meta.url,
  uses: [StyledCard],
});
