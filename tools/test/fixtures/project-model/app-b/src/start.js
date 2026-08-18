export class Start extends HTMLElement {}

await defineComponent({ tag: 'fx-start', element: Start, module: import.meta.url, template: false });
