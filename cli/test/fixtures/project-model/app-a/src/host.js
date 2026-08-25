import { Child } from './child.js';

export class Host extends HTMLElement {}

await defineComponent({ tag: 'fx-host', element: Host, module: import.meta.url, uses: [Child] });
