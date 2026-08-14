import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';

/**
 * @typedef {object} Crumb
 * @property {string} label Already translated. This collection ships no strings.
 * @property {string} [href] Omitted for a step that is not navigable.
 */

/**
 * A breadcrumb trail, driven by data rather than by markup.
 *
 *     <ui-breadcrumb [.items]="trail" label="{{ t('app.breadcrumb') }}"></ui-breadcrumb>
 *
 * Data rather than slots because a trail is derived — from the route, from a
 * navigation model, from a record's ancestors — and expressing that as markup
 * means an `*for` at every call site plus the same three mistakes each time:
 * the last step linking to the page you are already on, the separator being a
 * real character a screen reader reads out, and `aria-current` missing.
 *
 * The last item is never a link, whatever the data says, because that is what
 * makes it the current page rather than an option.
 */
export class UiBreadcrumb extends SignalElement {
  static properties = {
    // A property, not an attribute: an array does not survive being stringified
    // into one, and `[.items]` is the binding that exists for exactly this.
    items: { attribute: false },
    separator: { type: String },
    label: { type: String },
    listClass: { type: String, attribute: 'list-class' },
    itemClass: { type: String, attribute: 'item-class' },
    linkClass: { type: String, attribute: 'link-class' },
    currentClass: { type: String, attribute: 'current-class' },
    separatorClass: { type: String, attribute: 'separator-class' },
  };

  /** @type {ReadonlyArray<Crumb>} */
  items = [];

  separator = '/';

  /** Accessible name for the <nav>. Several trails on one page must differ. */
  label = 'Breadcrumb';

  listClass = '';
  itemClass = '';
  linkClass = '';
  currentClass = '';
  separatorClass = '';

  /** @returns {Array<{ key: string, label: string, href: string | undefined }>} */
  get crumbs() {
    const last = this.items.length - 1;
    return this.items.map((item, index) => ({
      // Index is part of the key because two steps may legitimately share a
      // label — /accounts/acme/contacts/acme is not a contrived path.
      key: `${String(index)}:${item.label}`,
      label: item.label,
      href: index === last ? undefined : item.href,
    }));
  }
}

await defineComponent({ tag: 'ui-breadcrumb', element: UiBreadcrumb, module: import.meta.url });
