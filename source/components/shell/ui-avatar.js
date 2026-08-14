import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';

/**
 * A user avatar: the picture when there is one, the initials when there is not,
 * and the initials again when the picture 404s.
 *
 *     <ui-avatar name="Name Surname" src="/avatars/7.png"
 *                image-class="…" fallback-class="…"></ui-avatar>
 *
 * The third case is the one worth having a component for. An `<img>` whose src
 * fails renders as a broken-image glyph inside a carefully styled circle, and
 * it happens in exactly the situation nobody tests: a real deployment where an
 * upload was deleted.
 */
export class UiAvatar extends SignalElement {
  static properties = {
    src: { type: String },
    name: { type: String },
    initials: { type: String },
    imageClass: { type: String, attribute: 'image-class' },
    fallbackClass: { type: String, attribute: 'fallback-class' },
    broken: { state: true },
  };

  src = '';

  /** Full name. Used for the accessible name, and to derive initials. */
  name = '';

  /** Override the derived initials, for a locale where first-letters are wrong. */
  initials = '';

  imageClass = '';
  fallbackClass = '';

  /** Set once the image has failed, so the fallback is permanent for that src. */
  broken = false;

  get showImage() {
    return this.src !== '' && !this.broken;
  }

  /**
   * First letters of the first two words. `Intl.Segmenter` would be the correct
   * tool for a script without spaces; `initials` is the escape hatch until an
   * application needs one.
   *
   * @returns {string}
   */
  get shownInitials() {
    if (this.initials !== '') return this.initials;
    return this.name
      .split(/\s+/u)
      .filter((word) => word !== '')
      .slice(0, 2)
      .map((word) => word.slice(0, 1).toUpperCase())
      .join('');
  }

  /** @param {Map<PropertyKey, unknown>} changed */
  willUpdate(changed) {
    super.willUpdate(changed);
    // A new src deserves a fresh attempt; without this, one failure hides every
    // later picture for the life of the element.
    if (changed.has('src')) this.broken = false;
  }

  onImageError() {
    this.broken = true;
  }
}

await defineComponent({ tag: 'ui-avatar', element: UiAvatar, module: import.meta.url });
