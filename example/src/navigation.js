/**
 * The navigation model: one tree, four consumers.
 *
 *   the sidebar    renders it, hiding what the session cannot reach
 *   the router      derives the guarded section paths from it
 *   the breadcrumb  walks it to name where you are
 *   the page title  the same walk, one level shallower
 *
 * Labels are keys, never sentences. `nav.salesOrders` is resolved with `t()` at
 * render time, so a language change relabels the menu with no reload; a translated
 * string stored here would freeze at module evaluation.
 *
 * `scope` is the entitlement a leaf needs. It is used twice on purpose, and the two
 * uses are not redundant:
 *
 *   - the sidebar omits a leaf the session cannot use, because offering a link that
 *     lands on `/forbidden` is a worse experience than not offering it;
 *   - the route guard refuses it anyway, because a hidden link is not access
 *     control — the URL is still typeable, and the server enforces the same scope a
 *     third time.
 *
 * The two micro-frontends are deliberately absent. They are contributed by
 * `app.manifest.json` and appended by the shell at render time, so mounting a remote
 * is a manifest entry plus one message key and no edit here. See `app-root.js`.
 */

/**
 * @typedef {object} NavNode
 * @property {string} key Message key suffix, and the DOM key for `*for`.
 * @property {string} path
 * @property {string} [icon] Name in `./icons.js`. Groups have one; leaves do not.
 * @property {string} [scope] Entitlement required to see and enter this leaf.
 * @property {ReadonlyArray<NavNode>} [children]
 */

/** @type {ReadonlyArray<NavNode>} */
export const NAVIGATION = [
  {
    key: 'sales',
    path: '/sales',
    icon: 'sales',
    children: [
      { key: 'salesOrders', path: '/sales/orders', scope: 'sales:read' },
      { key: 'salesCustomers', path: '/sales/customers', scope: 'sales:read' },
    ],
  },
  {
    key: 'inventory',
    path: '/inventory',
    icon: 'inventory',
    children: [
      { key: 'inventoryProducts', path: '/inventory/products', scope: 'inventory:read' },
      { key: 'inventoryMovements', path: '/inventory/movements', scope: 'inventory:read' },
      { key: 'inventoryWarehouses', path: '/inventory/warehouses', scope: 'inventory:read' },
    ],
  },
  {
    key: 'people',
    path: '/people',
    icon: 'people',
    children: [
      { key: 'peopleEmployees', path: '/people/employees', scope: 'people:read' },
      { key: 'peopleTeams', path: '/people/teams', scope: 'people:read' },
    ],
  },
  {
    key: 'settings',
    path: '/settings',
    icon: 'settings',
    children: [
      { key: 'settingsProfile', path: '/settings/profile' },
      { key: 'settingsAppearance', path: '/settings/appearance' },
      { key: 'settingsUsers', path: '/settings/users', scope: 'users:read' },
      { key: 'settingsAudit', path: '/settings/audit', scope: 'audit:read' },
    ],
  },
];

/** Every leaf in the tree, flattened. */
export function navigationLeaves() {
  return NAVIGATION.flatMap((group) => group.children ?? []);
}

/**
 * The group and leaf that own a path.
 *
 * A detail route is *inside* its list's leaf — `/sales/orders/OR-00007` belongs to
 * `salesOrders` — so a leaf matches its own path and anything below it. Longest
 * match wins, which is what keeps `/settings/users` from being answered by
 * `/settings`.
 *
 * @param {string} path
 * @returns {{ group: NavNode, leaf: NavNode | undefined } | undefined}
 */
export function locate(path) {
  /** @type {{ group: NavNode, leaf: NavNode | undefined } | undefined} */
  let best;
  let bestLength = -1;

  for (const group of NAVIGATION) {
    for (const leaf of group.children ?? []) {
      if (!isWithin(path, leaf.path)) continue;
      if (leaf.path.length <= bestLength) continue;
      best = { group, leaf };
      bestLength = leaf.path.length;
    }
    if (best === undefined && isWithin(path, group.path)) {
      best = { group, leaf: undefined };
      bestLength = group.path.length;
    }
  }
  return best;
}

/**
 * @param {string} path
 * @param {string} base
 * @returns {boolean}
 */
export function isWithin(path, base) {
  return path === base || path.startsWith(`${base}/`);
}
