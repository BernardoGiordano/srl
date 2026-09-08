export class SurfaceBase extends HTMLElement {
  static get properties() {
    return {
      inheritedLabel: { attribute: 'inherited-label' },
      inheritedState: { state: true },
    };
  }

  /** @type {{ id: number, name: string }} */
  selection = { id: 0, name: '' };

  announceBase() {
    this.dispatchEvent(new CustomEvent('base-change', { detail: this.selection }));
  }
}
