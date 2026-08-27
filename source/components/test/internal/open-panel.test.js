import { assert, mount, present, unmountAll } from '../../../lib/test/harness.js';
import { openPanel, panelBinding } from '@components/internal/open-panel.js';

/**
 * The module three elements route their open panel through, and the one that had
 * no suite at all while it owned the geometry: flip-above, the viewport clamp,
 * the right-to-left flush and the re-measure were each a comment and a hope.
 *
 * Everything here runs against real layout in a real browser, because that is the
 * only place `getBoundingClientRect` means anything. Positions are asserted as
 * relations — the panel sits above the anchor, the panel starts no further left
 * than the margin — rather than as pixel values, so a scrollbar or a user-agent
 * border does not decide whether the suite passes.
 */

/** @type {(() => void)[]} */
let opened = [];

/** @param {() => void} release @returns {() => void} */
function track(release) {
  opened.push(release);
  return release;
}

/**
 * An anchor pinned where the test wants it, and a panel taller than any room
 * below it.
 *
 * @param {string} anchorStyle
 * @returns {{ host: HTMLElement, trigger: HTMLElement, panel: HTMLElement }}
 */
function fixture(anchorStyle) {
  const host = mount(`
    <div>
      <button data-part="trigger" style="position: fixed; width: 120px; height: 24px; ${anchorStyle}">
        open
      </button>
      <div data-part="panel" style="width: 200px;">
        <div style="height: 600px;">tall</div>
      </div>
    </div>
  `);
  return {
    host,
    trigger: /** @type {HTMLElement} */ (present(host.querySelector('[data-part="trigger"]'))),
    panel: /** @type {HTMLElement} */ (present(host.querySelector('[data-part="panel"]'))),
  };
}

/** @param {Element} target */
function pointerDown(target) {
  target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
}

/** @returns {KeyboardEvent} */
function escape() {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  document.body.dispatchEvent(event);
  return event;
}

describe('openPanel', () => {
  afterEach(() => {
    for (const release of opened) release();
    opened = [];
    unmountAll();
  });

  it('hangs the panel under its anchor and promotes it to the top layer', () => {
    const { host, trigger, panel } = fixture('left: 40px; top: 20px;');

    track(openPanel(host, trigger, panel, { onDismiss: () => undefined }));

    const anchor = trigger.getBoundingClientRect();
    const box = panel.getBoundingClientRect();
    assert.ok(box.top >= anchor.bottom, `panel at ${String(box.top)}, anchor ends ${String(anchor.bottom)}`);
    // The whole reason for the top layer: no ancestor's overflow can clip it.
    assert.equal(document.querySelector(':popover-open'), panel);
  });

  it('flips above when the room below will not hold it', () => {
    const { host, trigger, panel } = fixture('left: 40px; bottom: 6px;');

    track(openPanel(host, trigger, panel, { onDismiss: () => undefined }));

    const anchor = trigger.getBoundingClientRect();
    const box = panel.getBoundingClientRect();
    assert.ok(
      box.bottom <= anchor.top,
      `six pixels of room below and 600 of content: the panel belongs above, not at ${String(box.top)}`,
    );
    assert.ok(box.top >= 8, 'and still inside the viewport margin');
  });

  it('clamps a panel whose anchor hangs off the edge', () => {
    const { host, trigger, panel } = fixture('left: -60px; top: 20px;');

    track(openPanel(host, trigger, panel, { onDismiss: () => undefined }));

    assert.equal(Math.round(panel.getBoundingClientRect().left), 8, 'the viewport margin wins');
  });

  it('reads `end` as a logical edge, so it changes sides in right-to-left', () => {
    const { host, trigger, panel } = fixture('left: 200px; top: 20px;');
    const anchor = trigger.getBoundingClientRect();

    const release = track(openPanel(host, trigger, panel, { align: 'end', onDismiss: () => undefined }));
    const ltr = panel.getBoundingClientRect();
    assert.ok(
      Math.abs(ltr.right - anchor.right) <= 1,
      `flush with the anchor's right in ltr: ${String(ltr.right)} vs ${String(anchor.right)}`,
    );
    release();

    host.setAttribute('dir', 'rtl');
    track(openPanel(host, trigger, panel, { align: 'end', onDismiss: () => undefined }));
    const rtl = panel.getBoundingClientRect();
    assert.ok(
      Math.abs(rtl.left - anchor.left) <= 1,
      `and with its left in rtl: ${String(rtl.left)} vs ${String(anchor.left)}`,
    );
  });

  it('follows the anchor when something moves it', () => {
    const { host, trigger, panel } = fixture('left: 40px; top: 20px;');

    track(openPanel(host, trigger, panel, { onDismiss: () => undefined }));
    const before = panel.getBoundingClientRect().top;

    // A scrolling card, not the window: the listener is registered in the capture
    // phase for exactly this, and the panel has to be re-placed either way.
    trigger.style.top = '160px';
    window.dispatchEvent(new Event('scroll'));

    assert.ok(
      panel.getBoundingClientRect().top > before,
      'a panel that stays where the anchor used to be is the bug the re-measure exists for',
    );
  });

  it('matches the anchor width only when asked to stretch', () => {
    const { host, trigger, panel } = fixture('left: 40px; top: 20px;');

    const release = track(openPanel(host, trigger, panel, { align: 'stretch', onDismiss: () => undefined }));
    assert.equal(panel.style.width, '120px');
    release();

    panel.style.width = '200px';
    track(openPanel(host, trigger, panel, { align: 'start', onDismiss: () => undefined }));
    assert.equal(panel.style.width, '200px', 'start and end leave the width alone');
  });

  it('announces the panel from the trigger, and takes it back on release', () => {
    const { host, trigger, panel } = fixture('left: 40px; top: 20px;');
    assert.notOk(panel.id, 'no id until something needs to point at it');

    const release = track(openPanel(host, trigger, panel, { onDismiss: () => undefined }));

    assert.ok(panel.id.startsWith('ui-panel-'), panel.id);
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    assert.equal(trigger.getAttribute('aria-controls'), panel.id);

    release();

    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    // Removed rather than emptied: `aria-controls` naming an element that is not
    // in the document is the state the template binding used to leave behind.
    assert.equal(trigger.getAttribute('aria-controls'), null);
    assert.equal(document.querySelector(':popover-open'), null);
  });

  it('dismisses on a pointer outside the host and ignores one inside it', () => {
    const { host, trigger, panel } = fixture('left: 40px; top: 20px;');
    /** @type {string[]} */
    const dismissed = [];

    track(openPanel(host, trigger, panel, { onDismiss: (reason) => void dismissed.push(reason) }));

    pointerDown(trigger);
    pointerDown(panel);
    assert.sameArray(dismissed, [], 'the gesture that opened it must not close it');

    pointerDown(document.body);
    assert.sameArray(dismissed, ['outside']);
  });

  it('dismisses on Escape, and moves focus before the panel can go', () => {
    const { host, trigger, panel } = fixture('left: 40px; top: 20px;');
    /** @type {string[]} */
    const dismissed = [];

    track(
      openPanel(host, trigger, panel, {
        onDismiss: (reason) => {
          // Focus has to be off the panel by now: this is the callback that
          // removes it, and focus left on a removed element sends the next Tab to
          // the top of the document.
          assert.equal(document.activeElement, trigger);
          dismissed.push(reason);
        },
      }),
    );

    const event = escape();
    assert.sameArray(dismissed, ['escape']);
    assert.ok(event.defaultPrevented, 'the key was consumed, so a dialog behind it stays open');
  });

  it('stops listening once released, and releases only once', () => {
    const { host, trigger, panel } = fixture('left: 40px; top: 20px;');
    /** @type {string[]} */
    const dismissed = [];

    const release = openPanel(host, trigger, panel, {
      onDismiss: (reason) => void dismissed.push(reason),
    });
    release();
    release();

    pointerDown(document.body);
    escape();
    assert.sameArray(dismissed, [], 'a released panel is nobody');
  });

  it('leaves position to the consumer when there is no anchor', () => {
    const { host, trigger, panel } = fixture('left: 40px; top: 20px;');
    /** @type {string[]} */
    const dismissed = [];

    track(
      openPanel(host, trigger, panel, {
        anchor: null,
        onDismiss: (reason) => void dismissed.push(reason),
      }),
    );

    assert.equal(panel.style.position, '', 'ui-menu positions its own with two classes');
    assert.equal(document.querySelector(':popover-open'), null);
    // Everything else an open panel owes is still owed.
    assert.equal(trigger.getAttribute('aria-controls'), panel.id);
    pointerDown(document.body);
    assert.sameArray(dismissed, ['outside']);
  });
});

describe('panelBinding', () => {
  afterEach(() => {
    unmountAll();
  });

  /**
   * A component's shape without the component: a trigger that is always there and
   * a panel that exists only while it is open.
   *
   * @returns {{ host: HTMLElement, render: (open: boolean) => HTMLElement | null }}
   */
  function component() {
    const host = mount(`
      <div>
        <button data-part="trigger" style="position: fixed; left: 40px; top: 20px;">open</button>
      </div>
    `);
    return {
      host,
      render(open) {
        host.querySelector('[data-part="panel"]')?.remove();
        if (!open) return null;
        const panel = document.createElement('div');
        panel.dataset['part'] = 'panel';
        panel.textContent = 'contents';
        host.append(panel);
        return panel;
      },
    };
  }

  /**
   * @param {HTMLElement} host
   * @param {() => AbortSignal} [lifetime]
   * @param {() => void} [onDismiss]
   */
  function bind(host, lifetime, onDismiss) {
    return panelBinding({
      host,
      trigger: '[data-part="trigger"]',
      panel: '[data-part="panel"]',
      lifetime,
      onDismiss: onDismiss ?? (() => undefined),
    });
  }

  it('opens what the render produced, and does not reopen it on the next update', () => {
    const { host, render } = component();
    const binding = bind(host);
    const trigger = present(host.querySelector('[data-part="trigger"]'));

    binding.sync(false);
    assert.equal(trigger.getAttribute('aria-controls'), null, 'nothing to point at yet');

    const panel = present(render(true));
    binding.sync(true);
    const id = panel.id;
    assert.equal(trigger.getAttribute('aria-controls'), id);

    // The two fields this replaces existed for this line: a component re-renders
    // for reasons that have nothing to do with the panel, and tearing it down and
    // putting it back would drop the scroll position and the popover with it.
    binding.sync(true);
    assert.equal(panel.id, id, 'same panel, same open');
    assert.equal(document.querySelector(':popover-open'), panel);

    render(false);
    binding.sync(false);
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(document.querySelector(':popover-open'), null);
  });

  it('waits rather than opening half a panel', () => {
    const { host, render } = component();
    const binding = bind(host);
    const trigger = present(host.querySelector('[data-part="trigger"]'));
    trigger.remove();

    render(true);
    binding.sync(true);
    assert.equal(document.querySelector(':popover-open'), null, 'no trigger, no announcement');

    host.prepend(trigger);
    binding.sync(true);
    assert.equal(trigger.getAttribute('aria-expanded'), 'true', 'and it tries again next update');
  });

  it('closes with the element, and opens again when the element comes back', () => {
    const { host, render } = component();
    let controller = new AbortController();
    const binding = bind(host, () => controller.signal);

    const panel = present(render(true));
    binding.sync(true);
    assert.equal(document.querySelector(':popover-open'), panel);

    // What `onDestroy` used to write by hand, three lines per element.
    controller.abort();
    assert.equal(document.querySelector(':popover-open'), null);

    // A SignalElement mints a new lifetime every time it re-enters the DOM, which
    // is why the signal is read at each open rather than captured once. Held from
    // the first open, this panel would never open again.
    controller = new AbortController();
    const second = present(render(true));
    binding.sync(true);
    assert.equal(document.querySelector(':popover-open'), second);
    binding.close();
  });

  it('hands the dismissal reason back to the component', () => {
    const { host, render } = component();
    /** @type {string[]} */
    const dismissed = [];
    const binding = bind(host, undefined, () => void dismissed.push('closed'));

    render(true);
    binding.sync(true);
    pointerDown(document.body);
    assert.sameArray(dismissed, ['closed']);

    // The component has not re-rendered yet, so the panel is still open and still
    // listening — the second gesture is the user pressing Escape on the same frame.
    escape();
    assert.sameArray(dismissed, ['closed', 'closed']);
    binding.close();
  });
});
