import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';

/**
 * A component that names no template at all, so the one it renders is whatever
 * `@core/elements/component.js` derives from this module's own URL. A fixture rather than a
 * class inside the test file, because deriving a sibling `.html` is only a real
 * test when the module and the markup are two files on disk.
 */
export class DerivedHost extends SignalElement {}

await defineComponent({ tag: 'derived-host', element: DerivedHost, module: import.meta.url });
