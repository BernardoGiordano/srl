// Test source with a perfectly readable declaration: its markup is claimed, so it is not
// an orphan — and it still never reaches an application's template bundle.
export class InTest extends HTMLElement {}

await defineComponent({ tag: 'fx-in-test', element: InTest, module: import.meta.url });
