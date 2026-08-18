// A suite doing its job: this is the shape the runtime must reject, so a static tool
// reporting it as a build failure would make the suite unwritable. A note, never an error.
await defineComponent({ tag: `fx-${'built'}`, element: class extends HTMLElement {} });
