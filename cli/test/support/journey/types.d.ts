/**
 * The readings a journey may take, as types.
 *
 * This is the observable interaction interface written down. The observer produces
 * these shapes inside the page, the driver forwards them, and the journey is typechecked
 * against them, so a step that asks for a property no engine reports fails before a
 * browser is launched and adding an observation means adding it here.
 */

/** Whatever currently has focus, in the terms a journey refers to it by. */
export interface FocusReading {
  /** Lowercase tag name, or '' when focus is on the body. */
  tag: string;
  id: string;
  /** The name assistive technology would announce. */
  name: string;
  /** The collection's `data-ui-part`, when focus is on one. */
  part: string;
  role: string;
  /** `aria-rowindex` of the row focus sits in, or null when it sits outside one. */
  rowIndex: number | null;
}

/** A form control and the error it is pointed at. */
export interface FieldReading {
  value: string;
  invalid: boolean;
  describedBy: string;
  /** The text `aria-describedby` resolves to, joined. */
  described: string;
  /** The text of the field's `role="alert"` paragraph, or '' when it has none. */
  alert: string;
}

export interface ComboboxReading {
  expanded: boolean;
  /** The label of `aria-activedescendant`, or '' when nothing is active. */
  activeOption: string;
  activeSelected: boolean;
  options: number;
  /** The labels of the options carrying `aria-selected`. */
  chosen: string[];
  /** What the control's input shows, such as a single-choice combobox's answer when closed. */
  value: string;
}

export interface DialogReading {
  open: boolean;
  role: string;
  label: string;
  /** Whether the native dialog matches `:modal`, so the page behind it is inert. */
  modal: boolean;
  focusInside: boolean;
  focusName: string;
}

export interface TableReading {
  /** `aria-rowcount`: every row the table has, header included. */
  rowCount: number;
  /** How many rows reached the DOM. */
  rendered: number;
  /** `aria-rowindex` of the first and last rendered rows, or null when none are. */
  firstIndex: number | null;
  lastIndex: number | null;
  scrollTop: number | null;
  scrollHeight: number | null;
  viewport: number | null;
  /** Checked selection boxes among the rendered rows, rather than the selection's size. */
  checked: number;
}

/** Every observation by name, and what it answers with. */
export interface Observations {
  ready: boolean;
  route: string;
  focus: FocusReading;
  announced: string[];
  field: FieldReading | null;
  combobox: ComboboxReading | null;
  dialog: DialogReading | null;
  table: TableReading | null;
  focusRowCheckbox: boolean;
  focusField: boolean;
  go: boolean;
}
