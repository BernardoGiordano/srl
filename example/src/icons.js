/**
 * Icons as path data.
 *
 * The sidebar is rendered from the navigation model, so its icons have to be data
 * too: a component cannot receive markup through an attribute, and injecting an
 * SVG string would need `unsafeHTML`, which is the one Lit directive worth
 * refusing in a project whose templates never touch `innerHTML`.
 *
 * Each icon is a list of subpaths on a 24×24 grid, joined into the `d` of a single
 * `<path>` and stroked with `currentColor`. One path rather than one element per
 * stroke is not a style choice: `*for` compiles its body into a template of its
 * own and Lit parses every template as HTML, so a bare `<path>` outside an `<svg>`
 * becomes an `HTMLUnknownElement` and draws nothing. Path data concatenates, so
 * nothing is lost. Circles are two arcs for the same reason.
 */

/** @type {Readonly<Record<string, ReadonlyArray<string>>>} */
const ICONS = {
  // Speedometer: an arc and a needle.
  dashboard: ['M4 17a8 8 0 1 1 16 0', 'M12 17l4.5-5.5', 'M3 17h3', 'M18 17h3'],

  // Trolley.
  sales: [
    'M3 5h2l2.5 9.5h10L20 8H7',
    'M9.5 18.5A1.2 1.2 0 0 1 9.5 20.9A1.2 1.2 0 0 1 9.5 18.5',
    'M16 18.5A1.2 1.2 0 0 1 16 20.9A1.2 1.2 0 0 1 16 18.5',
  ],

  // Cube.
  inventory: ['M12 3l8 4.5v9L12 21l-8-4.5v-9z', 'M4 7.5L12 12l8-4.5', 'M12 12v9'],

  // Two people, the second behind.
  people: [
    'M9 5A3.5 3.5 0 0 1 9 12A3.5 3.5 0 0 1 9 5',
    'M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5',
    'M16.2 6.4a3.2 3.2 0 0 1 0 6.4',
    'M17.6 15.2c2.1.7 3.4 2.4 3.4 4.8',
  ],

  // Axes and a rising line: the analytics remote.
  analytics: ['M4 4v16h16', 'M7 15l3.5-4 3 2.5L19 7', 'M15.5 7H19v3.5'],

  // Invoice with a currency mark: the billing remote.
  billing: ['M6 3h12v18l-3-2-3 2-3-2-3 2z', 'M9 8h6', 'M9 12h6', 'M9 16h3'],

  // Sliders.
  settings: [
    'M4 8h6',
    'M14 8h6',
    'M4 16h10',
    'M18 16h2',
    'M12 6A2 2 0 0 1 12 10A2 2 0 0 1 12 6',
    'M16 14A2 2 0 0 1 16 18A2 2 0 0 1 16 14',
  ],

  palette: [
    'M12 3a9 9 0 0 0 0 18h1.3a1.7 1.7 0 0 0 1.1-3c-.8-.7-.3-2 1-2H18a3 3 0 0 0 3-3c0-5.5-4-10-9-10z',
    'M7.5 9A1 1 0 0 1 7.5 11A1 1 0 0 1 7.5 9',
    'M11 6.5A1 1 0 0 1 11 8.5A1 1 0 0 1 11 6.5',
    'M15 8A1 1 0 0 1 15 10A1 1 0 0 1 15 8',
  ],

  globe: ['M12 3A9 9 0 0 1 12 21A9 9 0 0 1 12 3', 'M3 12h18', 'M12 3c3 3 3 15 0 18', 'M12 3c-3 3-3 15 0 18'],
  bolt: ['M13 3L6 13h5l-1 8 8-11h-5z'],
  warning: ['M12 4l9 16H3z', 'M12 10v4.5', 'M12 17.2v.2'],
  chevronDown: ['M6 9.5l6 6 6-6'],
  chevronRight: ['M9.5 6l6 6-6 6'],
  chevronLeft: ['M14.5 6l-6 6 6 6'],
  bell: ['M6 9a6 6 0 0 1 12 0c0 4 1.6 5.5 1.6 5.5H4.4S6 13 6 9z', 'M10 18a2 2 0 0 0 4 0'],
  menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
  search: ['M10.5 5A5.5 5.5 0 0 1 10.5 16A5.5 5.5 0 0 1 10.5 5', 'M14.6 14.6L20 20'],
  logout: [
    'M15 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-2',
    'M10 12h10',
    'M17 9l3 3-3 3',
  ],
  user: ['M12 4.5A3.5 3.5 0 0 1 12 11.5A3.5 3.5 0 0 1 12 4.5', 'M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6'],
  shield: ['M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z', 'M9 12l2.2 2.2L15.5 10'],
  clock: ['M12 3A9 9 0 0 1 12 21A9 9 0 0 1 12 3', 'M12 7.5V12l3.2 2'],
};

/**
 * The `d` attribute for one icon. An unknown name draws nothing rather than
 * throwing: an icon is decoration, and a missing one must not take a page down.
 *
 * @param {string | undefined} name
 * @returns {string}
 */
export function iconPath(name) {
  return ((name === undefined ? undefined : ICONS[name]) ?? []).join(' ');
}
