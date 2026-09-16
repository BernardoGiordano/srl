/**
 * One accessible interaction journey, written once and run by every engine.
 *
 * The journey is the unit a support claim is made about. Its steps are the composed
 * behaviour the focused suites each prove in isolation and nothing proves together. A
 * windowed table keeps its selection and its focus while the window moves under it, a
 * field's asynchronous answer arrives as an error assistive technology is pointed at, a
 * combobox is driven entirely from the keyboard, and a modal takes focus, is answered
 * with a key, and gives focus back.
 *
 * It may touch keys, and readings taken through the accessibility surface. It never
 * calls a component method, never asserts on a class field, and never clicks, because a
 * journey that calls `table.toggleRow()` proves the application can call itself, which
 * is not in doubt and is identical on every engine. Focus is seeded into the page
 * twice, once onto a row's checkbox and once onto the email control, because a journey
 * that tabbed forty times to reach a form would be measuring the shell's tab order
 * rather than the screen's. Both seeds land where a keyboard user could have landed,
 * and every interaction after them is a real key.
 *
 * Navigation goes through the history API rather than a link, for the same reason. The
 * interaction under test at the end is the discard dialog rather than the sidebar. The
 * route guard, the rollback and the dialog it raises are all the real ones.
 *
 * Each step returns a record of what it observed, which is what the support matrix
 * publishes. A step that passed silently would leave the matrix saying "green" and
 * nothing else, and "green" is the claim this whole arrangement exists to replace.
 * ADR-0116.
 */

import assert from 'node:assert/strict';

/** The screen with the windowed table, and the customer the form journey edits. */
const MOVEMENTS = '/inventory/movements';
const CUSTOMER = '/sales/customers/CU-0001';
const CUSTOMER_LIST = '/sales/customers';

/**
 * Edit mode is a query rather than a button. The screen derives it from the URL and
 * the session's scopes together, so this is how a user with `sales:write` arrives at an
 * editable form.
 */
const CUSTOMER_EDIT = `${CUSTOMER}?edit=true`;

/** Another customer's address, so the server's uniqueness answer is `taken`. */
const TAKEN_EMAIL = 'borealis.logistics@example.com';

/**
 * Enough forward moves to carry focus well past the first window without reaching the end
 * of the 120 rows the screen asks for.
 */
const ROWS_TO_CROSS = 18;

/** Longer than the longest value the journey clears, so one End + Backspaces empties it. */
const CLEAR_PRESSES = 60;

/**
 * The strings the journey recognises, in both languages the example ships a full
 * bundle for. Matching text is what makes the assertion real, because an assertion on a
 * code would pass while the user was being shown nothing.
 */
const SELECTED = /(movements? selected|moviment[oi] selezionat)/iu;
const TAKEN = /(already uses this|utilizza già|usa già)/iu;

/**
 * The number in the announced selection summary, or null when nothing announced one.
 *
 * The count is read back out of the sentence a screen reader would have been given, not
 * out of the DOM: a windowed table renders only the rows in view, so counting checked
 * boxes answers "how many chosen rows are on screen" and the announcement is the only
 * place the real total appears.
 *
 * @param {readonly string[]} spoken
 * @returns {number | null}
 */
function announcedSelection(spoken) {
  for (const line of spoken) {
    if (!SELECTED.test(line)) continue;
    const digits = /\d+/u.exec(line);
    if (digits !== null) return Number(digits[0]);
  }
  return null;
}

/**
 * @typedef {import('./engines.mjs').Driver} Driver
 * @typedef {{ id: string, title: string, observed: Record<string, unknown> }} Step
 */

/**
 * @param {Driver} driver
 * @returns {Promise<Step[]>}
 */
export async function runJourney(driver) {
  /** @type {Step[]} */
  const steps = [];

  /**
   * @param {string} id
   * @param {string} title
   * @param {Record<string, unknown>} observed
   */
  const record = (id, title, observed) => {
    steps.push({ id, title, observed });
  };

  await driver.goto('/');
  await driver.until(
    'ready',
    ['shell-layout'],
    (ready) => ready === true,
    'the application shell to start',
  );

  /* ── A window over more rows than the DOM holds ───────────────────────────── */

  await driver.observe('go', MOVEMENTS);
  const windowed = await driver.until(
    'table',
    [],
    (table) => table !== null && table.rowCount > 1 && table.rendered > 0,
    'the movements table to render its first window',
  );

  assert.equal(windowed.rowCount, 121, 'aria-rowcount must count 120 movements and the header');
  assert.ok(
    windowed.rendered < 40,
    `a window must leave rows out of the DOM; ${String(windowed.rendered)} of 120 were rendered`,
  );
  assert.equal(windowed.firstIndex, 2, 'the first rendered row must be the first data row');
  assert.ok(
    windowed.scrollHeight !== null && windowed.viewport !== null,
    'a windowed table must have a scroller to measure',
  );
  assert.ok(
    windowed.scrollHeight > windowed.viewport,
    'the scroller must hold the extent of every row, rendered or not',
  );

  record('windowed-rows', 'A table window renders a fraction of the rows it announces', {
    rowCount: windowed.rowCount,
    rendered: windowed.rendered,
    scrollHeight: windowed.scrollHeight,
    viewport: windowed.viewport,
  });

  /* ── Choosing a row with the keyboard ─────────────────────────────────────── */

  assert.equal(
    await driver.observe('focusRowCheckbox', 2),
    true,
    'the first row must offer a focusable selection control',
  );
  await driver.press('Space');

  const chosenOne = await driver.until(
    'table',
    [],
    (table) => table.checked === 1,
    'the first row to report itself selected',
  );
  const announcedOne = await driver.until(
    'announced',
    [],
    (spoken) => spoken.some((line) => SELECTED.test(line)),
    'the selection count to be announced',
  );

  record('keyboard-selection', 'A row is chosen with Space and the count is announced', {
    checked: chosenOne.checked,
    announced: announcedOne.filter((line) => SELECTED.test(line)),
  });

  /* ── Moving the window with the keyboard, without losing focus ────────────── */

  await driver.advance(ROWS_TO_CROSS);

  const moved = await driver.until(
    'table',
    [],
    (table) => table.firstIndex !== null && table.firstIndex > 2,
    'moving focus through the rows to move the window',
  );
  const stillOnARow = await driver.observe('focus');

  assert.equal(
    stillOnARow.part,
    'table-select-row',
    'focus must survive the window re-rendering under it',
  );
  assert.ok(
    stillOnARow.rowIndex !== null && stillOnARow.rowIndex > 2,
    'focus must have advanced past the row it started on',
  );
  assert.ok(
    moved.scrollTop !== null && moved.scrollTop > 0,
    'the scroller must have followed the focused row',
  );
  // The chosen row has left the DOM with the window. What the table renders and what
  // it has selected are two different sets now, which is the composition ADR-0105 and
  // ADR-0107 have to agree on, and the one a screen gets wrong by counting
  // checkboxes.
  assert.equal(moved.checked, 0, 'the chosen row must have left the DOM with the window');
  assert.equal(
    announcedSelection(await driver.observe('announced')),
    1,
    'a row scrolled out of the DOM must stay selected',
  );

  await driver.press('Space');
  await driver.until(
    'announced',
    [],
    (spoken) => announcedSelection(spoken) === 2,
    'a second, far-down row to join the selection',
  );
  const bothChosen = await driver.observe('table');

  assert.equal(
    bothChosen?.checked,
    1,
    'only the chosen row still in the window may be rendered as checked',
  );

  record('window-keeps-focus', 'Moving focus moves the window and the selection survives', {
    nextControlKey: driver.nextControl,
    firstIndexWhenMoved: moved.firstIndex,
    scrollTop: moved.scrollTop,
    focusedRow: stillOnARow.rowIndex,
    renderedWhenChosen: bothChosen?.rendered,
    checkedWhenChosen: bothChosen?.checked,
    announcedSelection: 2,
  });

  /* ── An asynchronous answer, announced as an error ────────────────────────── */

  await driver.observe('go', CUSTOMER_EDIT);
  await driver.until(
    'field',
    ['email'],
    (field) => field !== null && field.value !== '',
    'the customer form to load its values',
  );

  assert.equal(await driver.observe('focusField', 'email'), true, 'the email control must exist');
  await driver.press('End');
  await driver.press('Backspace', CLEAR_PRESSES);
  await driver.type(TAKEN_EMAIL);

  // Read once before waiting, so the record can say whether the answer was still in
  // flight when typing stopped. Evidence rather than an assertion, because a fast
  // enough machine could settle it between the last key and this reading, and a journey
  // that failed for that reason would be testing the clock.
  const whileChecking = await driver.observe('field', 'email');
  assert.notEqual(whileChecking, null, 'the email control must still be on the screen');

  // Leaving the field is what makes its error showable, because an error announced
  // under a control the user is still typing into interrupts them mid-word. The journey
  // moves on the way a keyboard user does, onto the next control, and the error has to
  // arrive on the field behind it. ADR-0103.
  await driver.advance();

  const refused = await driver.until(
    'field',
    ['email'],
    (field) => field.invalid && field.alert !== '',
    'the server-side uniqueness answer to arrive as an error',
  );

  assert.match(refused.alert, TAKEN, 'the error must be a sentence, not a code');
  assert.notEqual(refused.describedBy, '', 'the control must point at the error it earned');
  assert.equal(
    refused.described,
    refused.alert,
    'aria-describedby must resolve to the error a sighted user reads',
  );

  record('async-validation', 'An asynchronous refusal reaches the control that earned it', {
    settledWhileTyping: whileChecking?.alert !== '',
    invalid: refused.invalid,
    describedBy: refused.describedBy,
    error: refused.alert,
  });

  /* ── Choosing a combobox option with the keyboard ─────────────────────────── */

  // Focus is already here, because the move that blurred the email field landed on it
  // and a combobox opens when it is focused.
  const opened = await driver.until(
    'combobox',
    ['cf-segment'],
    (box) => box !== null && box.expanded && box.options > 0,
    'the segment combobox to open on focus',
  );

  // Down to an option the customer does not already have, so Enter is a choice rather
  // than an unchoosing. The screen loads with a segment, and the first option in the
  // list is sometimes the one it loaded with.
  let pointing = opened;
  for (let step = 0; step < opened.options; step += 1) {
    await driver.press('ArrowDown');
    pointing = await driver.until(
      'combobox',
      ['cf-segment'],
      (box) => box.activeOption !== '',
      'an option to become the active descendant',
    );
    if (!pointing.chosen.includes(pointing.activeOption)) break;
  }

  assert.notEqual(pointing.activeOption, '', 'an option must be announced as the active one');
  assert.equal(
    pointing.chosen.includes(pointing.activeOption),
    false,
    'the journey must point at an option the customer does not already have',
  );

  await driver.press('Enter');
  const chosenOption = await driver.until(
    'combobox',
    ['cf-segment'],
    (box) => box.chosen.includes(pointing.activeOption) || box.value === pointing.activeOption,
    `the active option ${pointing.activeOption} to be chosen`,
  );

  record('combobox-keyboard', 'A combobox option is reached and chosen with keys alone', {
    options: opened.options,
    activeOption: pointing.activeOption,
    chosen: chosenOption.chosen,
    value: chosenOption.value,
  });

  /* ── A modal that takes focus, answers to a key, and gives focus back ─────── */

  await driver.observe('go', CUSTOMER_LIST);

  const asking = await driver.until(
    'dialog',
    [],
    (dialog) => dialog !== null && dialog.open && dialog.focusInside,
    'the discard prompt to open and take focus',
  );

  assert.equal(asking.role, 'alertdialog', 'a prompt that interrupts must announce as one');
  assert.equal(asking.modal, true, 'the page behind the prompt must be inert');
  assert.notEqual(asking.label, '', 'the prompt must carry an accessible name');
  assert.notEqual(asking.focusName, '', 'focus must land on a named control inside the prompt');

  await driver.press('Enter');

  const answered = await driver.until(
    'dialog',
    [],
    (dialog) => !dialog.open,
    'the prompt to close on the focused answer',
  );
  const route = await driver.observe('route');
  const returned = await driver.until(
    'focus',
    [],
    (focus) => focus.tag !== '',
    'focus to return to the page behind the prompt',
  );

  assert.equal(route, CUSTOMER, 'refusing to leave must put the URL back');
  assert.equal(answered.focusInside, false, 'focus must not be left inside a closed dialog');

  record('dialog-focus-return', 'A modal is answered with a key and returns focus', {
    role: asking.role,
    label: asking.label,
    answeredControl: asking.focusName,
    route,
    focusAfter: `${returned.tag}${returned.id === '' ? '' : `#${returned.id}`}`,
  });

  const errors = driver.errors();
  assert.deepEqual(errors, [], `the journey must run without page errors: ${errors.join(' | ')}`);

  return steps;
}
