// Imported for the side effect alone, which is the whole declaration: running the
// module is what defines <fx-plain>, and `uses` below cannot name it.
import './side-effect-element.js';

export class SideEffectHost extends HTMLElement {}

await defineComponent({ tag: 'fx-side-effect-host', element: SideEffectHost, module: import.meta.url });
