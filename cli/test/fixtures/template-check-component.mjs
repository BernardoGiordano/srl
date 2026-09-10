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

  /** Internal implementation state, never caller input. */
  internal = [];

  /**
   * A fragment property over rows this element cannot type, the way a table
   * cannot type the rows a page hands it. A caller writing a fragment for it has
   * to say what a row is.
   *
   * @type {((row: unknown, index: number) => unknown) | undefined}
   */
  cell;

  /**
   * A fragment property that already knows its row, so the declared signature is
   * the whole answer and no annotation is needed.
   *
   * @type {((row: { id: number, name: string }) => unknown) | undefined}
   */
  typedCell;

  /** Not a fragment property. A fragment declared against it is a type error. */
  caption = '';
}
