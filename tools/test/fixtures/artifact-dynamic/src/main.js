import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';

class DynamicElement extends SignalElement {}

const definition = {
  tag: 'dynamic-element',
  element: DynamicElement,
  module: import.meta.url,
};

await defineComponent(definition);
