import { assert, mount, present, settled, unmountAll } from '../../../lib/test/harness.js';
import '@components/overlays/ui-dialog.js';

/** @import { UiDialog } from '@components/overlays/ui-dialog.js' */

/**
 * `ui-dialog`, which is mostly an argument about who owns `open`.
 *
 * The element delegates the hard half — the top layer, inertness, the focus trap
 * and the backdrop — to `showModal()`, and there is no point asserting the
 * browser implements its own specification. What is worth asserting is the part
 * this element decided: that Escape and a backdrop click *ask* rather than close,
 * that `mandatory` refuses to be asked at all, and that a screen driving `open`
 * from state of its own is never contradicted.
 */

/** @param {Element} element */
async function ready(element) {
  await settled(element);
  await settled(element);
}

/** @param {UiDialog} host @returns {HTMLDialogElement} */
function dialogOf(host) {
  return /** @type {HTMLDialogElement} */ (present(host.querySelector('dialog'), 'no <dialog> rendered'));
}

/** @param {UiDialog} host */
async function open(host) {
  host.open = true;
  await ready(host);
  return dialogOf(host);
}

/** Escape, as the browser delivers it to an open modal dialog. */
function pressEscape(/** @type {HTMLDialogElement} */ dialog) {
  dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
}

describe('ui-dialog', () => {
  afterEach(() => {
    unmountAll();
  });

  it('shows and hides the native dialog from `open`', async () => {
    const host = /** @type {UiDialog} */ (mount('<ui-dialog><p>Body</p></ui-dialog>'));
    await ready(host);

    const dialog = dialogOf(host);
    assert.notOk(dialog.open, 'a dialog starts closed');

    await open(host);
    assert.ok(dialog.open, '`open` shows it');
    assert.ok(dialog.matches(':modal'), 'and shows it modally, which is what puts a backdrop behind it');

    host.open = false;
    await ready(host);
    assert.notOk(dialog.open, 'and lowering `open` closes it again');
  });

  it('projects its content into the panel', async () => {
    const host = /** @type {UiDialog} */ (
      mount('<ui-dialog panel-class="w-96"><button type="button">Answer</button></ui-dialog>')
    );
    await open(host);

    const panel = present(host.querySelector('[data-ui-part="dialog-panel"]'), 'no panel rendered');
    assert.equal(panel.className, 'w-96', 'the panel wears the caller’s classes');
    assert.ok(panel.querySelector('button'), 'and holds the caller’s content');
  });

  it('names itself, and says which kind of dialog it is', async () => {
    const host = /** @type {UiDialog} */ (mount('<ui-dialog label="Discard?"></ui-dialog>'));
    await ready(host);
    const dialog = dialogOf(host);
    assert.equal(dialog.getAttribute('aria-label'), 'Discard?');
    assert.notOk(dialog.hasAttribute('role'), 'a plain dialog keeps the element’s own role');

    host.alert = true;
    await ready(host);
    assert.equal(dialog.getAttribute('role'), 'alertdialog', 'an interruption announces itself as one');
  });

  it('answers Escape by lowering `open` and saying so', async () => {
    const host = /** @type {UiDialog} */ (mount('<ui-dialog></ui-dialog>'));
    const dialog = await open(host);

    /** @type {Event[]} */
    const closes = [];
    host.addEventListener('close', (event) => closes.push(event));

    pressEscape(dialog);
    assert.equal(closes.length, 1, 'Escape is reported to the screen');
    assert.notOk(host.open, 'and lowers `open`, so a screen binding nothing still works');

    await ready(host);
    assert.notOk(dialog.open, 'the render that follows closes the native dialog');
  });

  it('closes on a click beside the panel, and not on one inside it', async () => {
    const host = /** @type {UiDialog} */ (
      mount('<ui-dialog><button type="button">Answer</button></ui-dialog>')
    );
    const dialog = await open(host);

    present(host.querySelector('button')).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    assert.ok(host.open, 'a click on the content is not a dismissal');

    dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    assert.notOk(host.open, 'a click on the layer around the panel is');
  });

  it('refuses both dismissals when it must be answered', async () => {
    const host = /** @type {UiDialog} */ (mount('<ui-dialog mandatory></ui-dialog>'));
    const dialog = await open(host);

    /** @type {Event[]} */
    const closes = [];
    host.addEventListener('close', (event) => closes.push(event));

    pressEscape(dialog);
    dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    assert.equal(closes.length, 0, 'a question with no safe default is not answered by a dismissal');
    assert.ok(host.open, 'and the dialog stays up');
    assert.ok(dialog.open, 'including the native one, so Escape did not close it underneath');
  });

  it('locks and releases the document scroll around itself', async () => {
    const host = /** @type {UiDialog} */ (mount('<ui-dialog></ui-dialog>'));
    await open(host);
    assert.equal(
      document.documentElement.style.overflow,
      'hidden',
      'the page behind an inert backdrop must not scroll under a wheel',
    );

    host.open = false;
    await ready(host);
    assert.equal(document.documentElement.style.overflow, '', 'and gets its scrollbar back');
  });

  it('releases the lock when it is removed while open', async () => {
    const host = /** @type {UiDialog} */ (mount('<ui-dialog></ui-dialog>'));
    await open(host);

    unmountAll();
    assert.equal(
      document.documentElement.style.overflow,
      '',
      'a dialog destroyed while open never fires close, so it releases the lock itself',
    );
  });
});
