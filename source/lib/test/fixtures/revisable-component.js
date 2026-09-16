import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';

/**
 * A component module that declares a different class each time it is evaluated.
 *
 * Replacing a component means running its module again, so the subject cannot be a
 * class written inside a test file. It has to be a real file the browser imports twice.
 * This is that file, and `?case=` picks which edit it stands for, covering the one edit
 * a live page can adopt and one of each it must refuse.
 *
 * The revision query is read rather than the file rewritten. `reviseComponentModule`
 * appends `?srl-revision=<n>` to get past the module map, which is the signal that this
 * evaluation is the edited one, so the class body can branch on it and the second
 * evaluation genuinely differs from the first.
 */

const here = new URL(import.meta.url);
const shape = here.searchParams.get('case') ?? 'method';
const edited = here.searchParams.has('srl-revision');

/**
 * The class this evaluation declares.
 *
 * Every one renders the same two bindings, so a test reads `.label` for the edit and
 * `.greeting` for what had to survive it.
 *
 * @returns {CustomElementConstructor}
 */
function classFor() {
  switch (shape) {
    // A method body, which is all a registered class can take.
    case 'method':
      return edited
        ? class extends SignalElement {
            greeting = 'hello';

            get label() {
              return 'after';
            }
          }
        : class extends SignalElement {
            greeting = 'hello';

            get label() {
              return 'before';
            }
          };

    // State in a private field. The second evaluation mints a private name of its
    // own, so the accessor adopted from it would read a field no live element has.
    case 'private':
      return edited
        ? class extends SignalElement {
            greeting = 'hello';

            #kept = 'after';

            get label() {
              return this.#kept;
            }
          }
        : class extends SignalElement {
            greeting = 'hello';

            get label() {
              return 'before';
            }
          };

    // A field the edit added. Its initialiser runs in a constructor the registry
    // does not hold, so no element would ever have it.
    case 'field':
      return edited
        ? class extends SignalElement {
            greeting = 'hello';

            extra = 'added';

            get label() {
              return this.extra;
            }
          }
        : class extends SignalElement {
            greeting = 'hello';

            get label() {
              return 'before';
            }
          };

    // A field whose initialiser changed. Same reason, and quieter, because the page
    // would keep showing the old value with nothing to say it had been edited.
    case 'initialiser':
      return edited
        ? class extends SignalElement {
            greeting = 'hi';

            get label() {
              return 'after';
            }
          }
        : class extends SignalElement {
            greeting = 'hello';

            get label() {
              return 'before';
            }
          };

    // A reactive property the edit added, meaning an accessor pair and an observed
    // attribute, both fixed when the tag was defined.
    case 'property':
      return edited
        ? class extends SignalElement {
            static properties = { open: { type: Boolean } };

            greeting = 'hello';

            get label() {
              return 'after';
            }
          }
        : class extends SignalElement {
            greeting = 'hello';

            get label() {
              return 'before';
            }
          };

    // A different base class. The one on screen inherits from an object this
    // evaluation no longer names.
    case 'base': {
      class Intermediate extends SignalElement {}
      return edited
        ? class extends Intermediate {
            greeting = 'hello';

            get label() {
              return 'after';
            }
          }
        : class extends SignalElement {
            greeting = 'hello';

            get label() {
              return 'before';
            }
          };
    }

    default:
      throw new Error(`No such case: ${shape}`);
  }
}

// The markup is named rather than derived, because the tag this module declares is
// computed and static discovery cannot read it. A sibling `.html` here would be markup
// no definition claims, which is what `orphanTemplates` exists to catch.
await defineComponent({
  tag: `revisable-${shape}`,
  element: classFor(),
  module: import.meta.url,
  template: 'revisable-markup.html',
});
