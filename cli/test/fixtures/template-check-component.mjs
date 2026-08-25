/** A typed host used by the Node-side template checker tests. */
export class TemplateCheckHost extends HTMLElement {
  /** @type {Array<{ id: number, name: string }>} */
  rows = [];

  busy = false;
  label = '';

  /** @type {import('../../../source/lib/core/template/types.js').TrustedHtml} */
  trustedHtml = /** @type {import('../../../source/lib/core/template/types.js').TrustedHtml} */ ({});

  /** @type {import('../../../source/lib/core/template/types.js').TrustedResourceUrl} */
  trustedResourceUrl = /** @type {import('../../../source/lib/core/template/types.js').TrustedResourceUrl} */ ({});

  /** @param {number} id */
  choose(id) {
    void id;
  }

  /**
   * A move-up/move-down pair, typed the ordinary way. The literal union is the
   * point: `-1` satisfies it only if the checker emits the minus against the
   * literal itself.
   *
   * @param {number} id
   * @param {1 | -1} direction
   */
  move(id, direction) {
    void id;
    void direction;
  }
}

/** A typed custom element input used by the property-binding test. */
export class TemplateCheckChild extends HTMLElement {
  /** @type {Array<{ id: number, name: string }>} */
  items = [];
}
