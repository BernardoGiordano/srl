import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';

/** An application that uses none of the collection and declares no locale. */
export class AppRoot extends SignalElement {}

await defineComponent({ tag: 'app-root', element: AppRoot, module: import.meta.url });
