/**
 * What a journey may see, expressed once and evaluated inside the page.
 *
 * This is the observable interaction interface the journey is written against. It keeps
 * the engine adapters thin, because an adapter navigates, presses a key and forwards one
 * `evaluate` call. Everything about what a running application looks like is decided
 * here, once, for every engine, including where focus is, what a dialog is announcing,
 * and which rows a window is holding.
 *
 * Every reading is taken through the accessibility surface rather than through the
 * component's internals. Focus is `document.activeElement` and the name it carries. A
 * field's error is the `role="alert"` paragraph its control points `aria-describedby`
 * at, a combobox's highlighted option is its `aria-activedescendant`, and a window's
 * position is `aria-rowindex` and `aria-rowcount`. An assertion written against a
 * private class field
 * would pass on an engine where a screen reader is told nothing, which is the failure this
 * journey exists to notice.
 *
 * It is a source string rather than a module because it is installed into a page over a
 * debugging protocol. The page's own Content-Security-Policy forbids script this file
 * would otherwise be delivered as, and the point of driving the built artifact is to leave
 * that policy exactly as production serves it.
 */

/**
 * The observer, as the page defines it on `globalThis.__journey`.
 *
 * Written as one IIFE with no imports and no optional chaining across frames, because
 * it is evaluated as-is by four different engines and has to parse in all of them.
 */
export const OBSERVER_SOURCE = `(() => {
  const text = (node) => (node === null ? '' : (node.textContent || '').replace(/\\s+/gu, ' ').trim());

  /** The name assistive technology would announce for an element. */
  const nameOf = (element) => {
    if (element === null) return '';
    const label = element.getAttribute('aria-label');
    if (label !== null && label.trim() !== '') return label.trim();
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy !== null) {
      const named = labelledBy
        .split(/\\s+/u)
        .map((id) => text(document.getElementById(id)))
        .filter((part) => part !== '')
        .join(' ');
      if (named !== '') return named;
    }
    if (element.id !== '') {
      const associated = document.querySelector('label[for="' + CSS.escape(element.id) + '"]');
      if (associated !== null) return text(associated);
    }
    return text(element);
  };

  /** How a journey refers to whatever currently has focus. */
  const describe = (element) => {
    if (element === null || element === document.body) return { tag: '', id: '', name: '', part: '', role: '', rowIndex: null };
    const row = element.closest('[data-ui-part="table-row"]');
    const rowIndex = row === null ? null : Number(row.getAttribute('aria-rowindex'));
    return {
      tag: element.tagName.toLowerCase(),
      id: element.id,
      name: nameOf(element),
      part: element.getAttribute('data-ui-part') || '',
      role: element.getAttribute('role') || '',
      rowIndex: Number.isFinite(rowIndex) ? rowIndex : null,
    };
  };

  const control = (fieldName) => {
    const field = document.querySelector('ui-field[name="' + CSS.escape(fieldName) + '"]');
    if (field === null) return null;
    return field.querySelector('input, textarea, select, ui-combobox [role="combobox"]');
  };

  globalThis.__journey = {
    /** The application has started and the screen the journey is on has rendered. */
    ready(selector) {
      return globalThis.__artifactReady === true && document.querySelector(selector) !== null;
    },

    route() {
      return location.pathname;
    },

    focus() {
      return describe(document.activeElement);
    },

    /** Everything a screen reader would have been told since the page rendered. */
    announced() {
      const regions = document.querySelectorAll('[aria-live], [role="alert"], [role="status"]');
      return Array.from(regions)
        .map((region) => text(region))
        .filter((spoken) => spoken !== '');
    },

    /**
     * A form field as its control describes itself, giving the value, whether it is
     * announced invalid, and the error text \`aria-describedby\` actually resolves
     * to.
     */
    field(fieldName) {
      const input = control(fieldName);
      if (input === null) return null;
      const describedBy = input.getAttribute('aria-describedby') || '';
      const described = describedBy
        .split(/\\s+/u)
        .map((id) => text(document.getElementById(id)))
        .filter((part) => part !== '');
      const alert = document.querySelector('ui-field[name="' + CSS.escape(fieldName) + '"] [role="alert"]');
      return {
        value: 'value' in input ? String(input.value) : '',
        invalid: input.getAttribute('aria-invalid') === 'true',
        describedBy,
        described: described.join(' '),
        alert: text(alert),
      };
    },

    /**
     * A combobox as it announces itself, giving whether it is expanded, which option
     * it points \`aria-activedescendant\` at, and which options carry
     * \`aria-selected\`. The chosen set
     * is read from the options rather than from the chips, because chips are the
     * multiple-choice presentation and a single-choice combobox shows its answer in the
     * input instead.
     */
    combobox(id) {
      const within = '#' + CSS.escape(id) + ' ';
      const input = document.querySelector(within + '[role="combobox"]');
      if (input === null) return null;
      const activeId = input.getAttribute('aria-activedescendant') || '';
      const active = activeId === '' ? null : document.getElementById(activeId);
      const options = Array.from(document.querySelectorAll(within + '[role="option"]'));
      return {
        expanded: input.getAttribute('aria-expanded') === 'true',
        activeOption: text(active),
        activeSelected: active !== null && active.getAttribute('aria-selected') === 'true',
        options: options.length,
        chosen: options
          .filter((option) => option.getAttribute('aria-selected') === 'true')
          .map((option) => text(option)),
        value: 'value' in input ? String(input.value) : '',
      };
    },

    /** The modal on the page, if the application has raised one. */
    dialog() {
      const element = document.querySelector('ui-dialog');
      if (element === null) return null;
      const dialog = element.querySelector('dialog');
      const open = dialog !== null && dialog.hasAttribute('open');
      const active = document.activeElement;
      return {
        open,
        role: dialog === null ? '' : dialog.getAttribute('role') || '',
        label: dialog === null ? '' : dialog.getAttribute('aria-label') || '',
        modal: dialog !== null && typeof dialog.matches === 'function' && dialog.matches(':modal'),
        focusInside: open && dialog !== null && active !== null && dialog.contains(active),
        focusName: nameOf(active),
      };
    },

    /**
     * A windowed table, giving what it claims to hold, what it actually rendered, and
     * where the scroller is. \`aria-rowcount\` and \`aria-rowindex\` are the numbers a
     * screen reader is given, so they are the numbers asserted on.
     */
    table() {
      const grid = document.querySelector('ui-table table');
      if (grid === null) return null;
      const scroller = document.querySelector('ui-table [data-ui-part="table-scroll"]');
      const rows = Array.from(document.querySelectorAll('ui-table [data-ui-part="table-row"]'));
      const indexes = rows
        .map((row) => Number(row.getAttribute('aria-rowindex')))
        .filter((index) => Number.isFinite(index));
      const boxes = document.querySelectorAll('ui-table [data-ui-part="table-select-row"]');
      return {
        rowCount: Number(grid.getAttribute('aria-rowcount')),
        rendered: rows.length,
        firstIndex: indexes.length === 0 ? null : Math.min.apply(null, indexes),
        lastIndex: indexes.length === 0 ? null : Math.max.apply(null, indexes),
        scrollTop: scroller === null ? null : Math.round(scroller.scrollTop),
        scrollHeight: scroller === null ? null : Math.round(scroller.scrollHeight),
        viewport: scroller === null ? null : Math.round(scroller.clientHeight),
        checked: Array.from(boxes).filter((box) => box.checked).length,
      };
    },

    /**
     * Put focus on one row's selection checkbox without a pointer, the way a keyboard
     * user arrives at it. The caller then presses real keys from there.
     */
    focusRowCheckbox(index) {
      const row = document.querySelector('ui-table [data-ui-part="table-row"][aria-rowindex="' + String(index) + '"]');
      if (row === null) return false;
      const box = row.querySelector('[data-ui-part="table-select-row"]');
      if (box === null) return false;
      box.focus();
      return document.activeElement === box;
    },

    /** Focus a named control the same way, so a journey step can start from it. */
    focusField(fieldName) {
      const input = control(fieldName);
      if (input === null) return false;
      input.focus();
      return true;
    },

    /** A same-document navigation, the way the shell's own links perform one. */
    go(path) {
      history.pushState(null, '', path);
      dispatchEvent(new PopStateEvent('popstate'));
      return true;
    },
  };
  return true;
})()`;
