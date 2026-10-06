import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { UiAvatar } from '@components/shell/ui-avatar.js';

import { avatarTone } from './avatar-tone.js';

/**
 * Render a titled surface with optional lead text, toolbar, and projected body.
 * Screens pass translated text through `heading` and `lead`.
 */
export class AppCard extends SignalElement {
  static properties = {
    heading: { type: String },
    lead: { type: String },
    eyebrow: { type: String },
    /** A name to show as an initials avatar beside the heading. */
    avatar: { type: String },
/** Remove body padding for full-width content. */
    flush: { type: Boolean, reflect: true },
  };

  heading = '';
  lead = '';
  eyebrow = '';
  avatar = '';
  flush = false;

  get bodyClasses() {
    return this.flush ? '' : 'px-5 pb-5 pt-3';
  }

  get avatarClasses() {
    return `flex size-10 shrink-0 items-center justify-center rounded-lg text-[14px] font-semibold ${avatarTone(this.avatar)}`;
  }

  /** A flush body starts at a rule, so the header closes with one. */
  get headerClasses() {
    return this.flush ? 'border-b border-ui-border pb-4' : 'pb-1';
  }
}

await defineComponent({
  tag: 'app-card',
  element: AppCard,
  module: import.meta.url,
  styles: true,
  uses: [UiAvatar],
});
