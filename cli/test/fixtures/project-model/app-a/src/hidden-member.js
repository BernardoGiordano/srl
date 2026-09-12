// A class field is installed with [[Define]], so it hides a method of the same name
// rather than overriding it. Every shape of that, and the shapes that are fine.

export class MemberBase extends HTMLElement {
  refresh() {
    this.dispatchEvent(new CustomEvent('base-refresh'));
  }
}

// The authored case: `refresh` is a method on the base class, and a value here covers it.
export class HiddenAuthored extends MemberBase {
  refresh = 'soon';
}

await defineComponent({
  tag: 'fx-hidden-authored',
  element: HiddenAuthored,
  module: import.meta.url,
  template: false,
});

// The inherited case: `render` comes from a root this model does not parse.
export class HiddenRender extends LitElement {
  render = 'state';
}

await defineComponent({
  tag: 'fx-hidden-render',
  element: HiddenRender,
  module: import.meta.url,
  template: false,
});

// A field whose value is decided elsewhere. It may well be a function, so this is a note.
const chosen = () => undefined;

export class HiddenUnknown extends MemberBase {
  refresh = chosen;
}

await defineComponent({
  tag: 'fx-hidden-unknown',
  element: HiddenUnknown,
  module: import.meta.url,
  template: false,
});

// Callable fields override nothing but work, and an ordinary field shares no name with a
// method. Neither is a finding.
export class VisibleMembers extends MemberBase {
  refresh = () => this.dispatchEvent(new CustomEvent('field-refresh'));

  label = 'fine';
}

await defineComponent({
  tag: 'fx-visible-members',
  element: VisibleMembers,
  module: import.meta.url,
  template: false,
});
