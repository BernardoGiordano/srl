/**
 * The sidebar, router, breadcrumbs, and page title share this navigation tree.
 * Labels stay as message keys so language changes take effect at render time.
 * Scopes hide links in the sidebar and guard typed URLs. The server enforces them
 * for API requests. Remotes join the tree from `app.manifest.json`.
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

/** All navigation leaves. */
export function navigationLeaves() {
  return NAVIGATION.flatMap((group) => group.children ?? []);
}

/**
 * Find the longest matching leaf, including detail routes below its path.
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
