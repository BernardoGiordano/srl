const TAG = `fx-${'computed'}`;
const SPEC = { tag: 'fx-from-variable', element: class extends HTMLElement {} };

class Dynamic extends HTMLElement {}

// A computed tag: works in the browser, invisible to every static tool.
await defineComponent({ tag: TAG, element: Dynamic, module: import.meta.url, template: false });

// A whole spec built elsewhere: the same problem one level up.
await defineComponent(SPEC);

// A bare registration with a computed class, which is the mechanism rather than a
// declaration: no template and no `uses` for a tool to lose.
customElements.define('fx-bare', class extends HTMLElement {});
