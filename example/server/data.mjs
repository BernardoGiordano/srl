/**
 * The dataset, in memory.
 *
 * No database, on purpose: an example application's backend should be readable in
 * one sitting and runnable with `node`, and every query in api.mjs is a few array
 * operations over the arrays below. What it does not fake is HTTP: paging,
 * sorting, filtering and authorization all happen here rather than in the browser,
 * so the client code is the code a real API needs and not a demo shortcut.
 *
 * Everything is generated from one seed, so two boots produce the same rows and a
 * screenshot or a failing assertion reproduces.
 *
 * Mutations (an order's status, a user's state) are applied to these objects and
 * are therefore lost on restart. That is the intended lifetime: this is a fixture,
 * not storage.
 */

import { createRandom } from './random.mjs';

const random = createRandom(20260115);

/** Fixed point the historical dates are measured back from. */
const EPOCH = Date.UTC(2026, 5, 30);
const DAY_MS = 86_400_000;

/**
 * @param {number} daysAgo
 * @returns {string} An ISO day, `YYYY-MM-DD`.
 */
function day(daysAgo) {
  return new Date(EPOCH - daysAgo * DAY_MS).toISOString().slice(0, 10);
}

/**
 * @param {number} minutesAgo
 * @returns {string} A full ISO timestamp, measured from process start so that
 *   relative formatting ("3 minutes ago") reads as live.
 */
function recent(minutesAgo) {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

/* ── Reference lists ──────────────────────────────────────────────────────── */

export const WAREHOUSES = Object.freeze([
  { id: 'WH-MIL', name: 'Milano Nord', city: 'Milano', country: 'IT', capacity: 12_000 },
  { id: 'WH-ROM', name: 'Roma Est', city: 'Roma', country: 'IT', capacity: 8_400 },
  { id: 'WH-BER', name: 'Berlin Süd', city: 'Berlin', country: 'DE', capacity: 15_200 },
  { id: 'WH-LYO', name: 'Lyon Centre', city: 'Lyon', country: 'FR', capacity: 6_900 },
  { id: 'WH-MAD', name: 'Madrid Sur', city: 'Madrid', country: 'ES', capacity: 7_500 },
  { id: 'WH-AMS', name: 'Amsterdam Haven', city: 'Amsterdam', country: 'NL', capacity: 10_100 },
]);

export const TEAMS = Object.freeze([
  { id: 'TM-ENG', name: 'Engineering', headcount: 0, lead: '' },
  { id: 'TM-OPS', name: 'Operations', headcount: 0, lead: '' },
  { id: 'TM-SAL', name: 'Sales', headcount: 0, lead: '' },
  { id: 'TM-CAR', name: 'Customer care', headcount: 0, lead: '' },
  { id: 'TM-FIN', name: 'Finance', headcount: 0, lead: '' },
  { id: 'TM-PRD', name: 'Product', headcount: 0, lead: '' },
]);

const ROLES = Object.freeze([
  'Account manager',
  'Backend engineer',
  'Data analyst',
  'Field technician',
  'Frontend engineer',
  'Logistics planner',
  'Payroll specialist',
  'Product manager',
  'QA engineer',
  'Site reliability engineer',
  'Support specialist',
  'Warehouse supervisor',
]);

const SEGMENTS = Object.freeze(['enterprise', 'midmarket', 'smb', 'public']);
const CHANNELS = Object.freeze(['direct', 'partner', 'web', 'edi']);
const ORDER_STATUS = Object.freeze(['draft', 'confirmed', 'shipped', 'invoiced', 'cancelled']);
const CATEGORIES = Object.freeze(['cabling', 'enclosures', 'meters', 'modems', 'routers', 'sensors']);

const FIRST_NAMES = Object.freeze([
  'Ada', 'Bruno', 'Chiara', 'Dario', 'Elena', 'Fabio', 'Giulia', 'Hassan', 'Irene', 'Jonas',
  'Karim', 'Laura', 'Marco', 'Nadia', 'Omar', 'Paola', 'Quirin', 'Rita', 'Samir', 'Teresa',
  'Ugo', 'Valeria', 'Wanda', 'Yusuf', 'Zaira',
]);

const LAST_NAMES = Object.freeze([
  'Aleotti', 'Bianchi', 'Conti', 'Duarte', 'Esposito', 'Ferrari', 'Greco', 'Haddad', 'Iervolino',
  'Jansen', 'Karim', 'Lombardi', 'Marino', 'Novak', 'Orsini', 'Pagano', 'Quaranta', 'Rossi',
  'Santoro', 'Tosi', 'Urso', 'Valli', 'Weber', 'Zanetti',
]);

const COMPANY_HEADS = Object.freeze([
  'Aurora', 'Borealis', 'Cedro', 'Delta', 'Estia', 'Fonte', 'Gaia', 'Helios', 'Iride', 'Kairos',
  'Lumen', 'Meridian', 'Nimbus', 'Orbis', 'Pergola', 'Quadra', 'Rialto', 'Serena', 'Tramonto',
  'Umbra', 'Vento', 'Zenit',
]);

const COMPANY_TAILS = Object.freeze(['Group', 'Utilities', 'Logistics', 'Industrie', 'Energia', 'Systems', 'Retail']);

/* ── Cities: the list a typeahead exists for ──────────────────────────────── */

/**
 * Eight thousand six hundred entries, which is the size at which "load the list
 * into a select" stops being an option and `ui-dynamic-filter`'s `typeahead` rule
 * is the only workable answer. Generated rather than shipped as a fixture file:
 * the point is the count, not the names.
 *
 * @type {ReadonlyArray<{ id: string, name: string, region: string }>}
 */
export const CITIES = Object.freeze(
  Array.from({ length: 8_600 }, (_unused, index) => {
    const stem = random.pick(COMPANY_HEADS);
    const suffix = random.pick(['', ' Alta', ' Bassa', ' Marittima', ' Ligure', ' Terme', ' Vecchia', ' Nuova']);
    return {
      id: `C${String(index + 1).padStart(5, '0')}`,
      name: `${stem}${suffix} ${String(index + 1)}`,
      region: random.pick(['Lombardia', 'Lazio', 'Veneto', 'Sicilia', 'Puglia', 'Piemonte']),
    };
  }),
);

/* ── Customers ────────────────────────────────────────────────────────────── */

/**
 * What a contact can be to a customer. Declared before the fixture rather than
 * beside it: the rows below are built while this module evaluates, so a `const`
 * underneath them is still in its temporal dead zone when they ask for it.
 */
export const CONTACT_ROLES = ['billing', 'technical', 'commercial'];

/**
 * The company names already handed out, so no two customers share one.
 *
 * Twenty-two heads over seven tails is a hundred and fifty-four combinations for
 * forty-eight draws, which collides often enough to matter: the API rejects a name
 * or an address a second customer already holds, so a pair of twins in the fixture
 * is a pair of records that cannot be saved back unchanged — `taken` against a field
 * the user never touched. Redrawing is bounded because the pool is larger than the
 * fixture.
 *
 * @type {Set<string>}
 */
const TAKEN_COMPANY_NAMES = new Set();

/** A company name no other customer in the fixture has. */
function uniqueCompanyName() {
  let name = '';
  do {
    name = `${random.pick(COMPANY_HEADS)} ${random.pick(COMPANY_TAILS)}`;
  } while (TAKEN_COMPANY_NAMES.has(name));
  TAKEN_COMPANY_NAMES.add(name);
  return name;
}

/**
 * Mutable, unlike most of this file: `/api/customers` accepts a POST and a PATCH, so
 * the array is the store the write path writes to. Nothing is persisted — a restart
 * is the reset button — which is the right amount of durability for an example whose
 * job is to make the round trip real rather than to keep it.
 *
 * @type {Array<{
 *   id: string, name: string, email: string, segment: string, city: string,
 *   country: string, since: string, openOrders: number, revenue: number,
 *   owner: string, notes: string,
 *   contacts: Array<{ name: string, email: string, role: string }>,
 * }>}
 */
export const CUSTOMERS = Array.from({ length: 48 }, (_unused, index) => {
  const warehouse = random.pick(WAREHOUSES);
  const name = uniqueCompanyName();
  // Derived from the name, so a unique name is a unique address as well — the
  // second rule the API checks across customers.
  const mailbox = name.toLowerCase().replaceAll(/[^a-z0-9]+/gu, '.');
  return {
    id: `CU-${String(index + 1).padStart(4, '0')}`,
    name,
    email: `${mailbox}@example.com`,
    segment: random.pick(SEGMENTS),
    city: warehouse.city,
    country: warehouse.country,
    since: day(400 + random.int(1_800)),
    openOrders: random.int(9),
    revenue: 18_000 + random.int(940_000),
    owner: `${random.pick(FIRST_NAMES)} ${random.pick(LAST_NAMES)}`,
    notes: '',
    // Zero, one or two, so a screen rendering these meets the empty case as well
    // as the repeating one without anybody having to construct it.
    //
    // The row number is in the address because two contacts of one customer may
    // not share one, and two random picks from the same name lists can collide —
    // a fixture that violates its own rule is a record that cannot be saved back
    // unchanged.
    contacts: Array.from({ length: random.int(3) }, (_ignored, row) => {
      const person = `${random.pick(FIRST_NAMES)} ${random.pick(LAST_NAMES)}`;
      const local = person.toLowerCase().replaceAll(/[^a-z0-9]+/gu, '.');
      return {
        name: person,
        email: `${local}.${row + 1}@${mailbox}.example.com`,
        role: random.pick(CONTACT_ROLES),
      };
    }),
  };
});

/* ── Products ─────────────────────────────────────────────────────────────── */

/**
 * @type {Array<{
 *   sku: string, name: string, category: string, warehouse: string,
 *   stock: number, reorderPoint: number, price: number, updatedAt: string,
 * }>}
 */
export const PRODUCTS = Array.from({ length: 640 }, (_unused, index) => {
  const category = random.pick(CATEGORIES);
  return {
    sku: `SKU-${String(index + 1).padStart(5, '0')}`,
    name: `${category.slice(0, 1).toUpperCase()}${category.slice(1, -1)} ${random.pick(COMPANY_HEADS)} ${String(100 + random.int(880))}`,
    category,
    warehouse: random.pick(WAREHOUSES).id,
    stock: random.int(1_400),
    reorderPoint: 40 + random.int(160),
    price: Number((4 + random.next() * 780).toFixed(2)),
    updatedAt: recent(random.int(20_000)),
  };
});

/* ── Orders and their lines ───────────────────────────────────────────────── */

/**
 * @type {Array<{
 *   id: string, code: string, customerId: string, customer: string, status: string,
 *   channel: string, placedOn: string, promisedOn: string, currency: string,
 *   total: number, owner: string, city: string, comuneId: string, comune: string,
 * }>}
 */
export const ORDERS = Array.from({ length: 312 }, (_unused, index) => {
  const customer = random.pick(CUSTOMERS);
  // The delivery municipality, drawn from the 8,600-entry list. This is the field
  // the typeahead filter exists for: nothing can hand that list to a browser, and
  // nobody scrolls it.
  const comune = random.pick(CITIES);
  const placedDaysAgo = random.int(540);
  return {
    id: `OR-${String(index + 1).padStart(5, '0')}`,
    code: `${String(2025 + (placedDaysAgo < 180 ? 1 : 0))}-${String(index + 1).padStart(5, '0')}`,
    customerId: customer.id,
    customer: customer.name,
    status: random.pick(ORDER_STATUS),
    channel: random.pick(CHANNELS),
    placedOn: day(placedDaysAgo),
    promisedOn: day(Math.max(0, placedDaysAgo - 10 - random.int(30))),
    currency: random.pick(['EUR', 'EUR', 'EUR', 'CHF', 'GBP']),
    total: Number((320 + random.next() * 84_000).toFixed(2)),
    owner: customer.owner,
    city: customer.city,
    comuneId: comune.id,
    comune: comune.name,
  };
});

/**
 * Lines, keyed by order id. A separate endpoint rather than an embedded array,
 * because the detail screen's tabs are separate routes and each fetches its own
 * slice — which is what makes the child-route layout worth having.
 *
 * @type {Map<string, Array<{ line: number, sku: string, name: string, quantity: number, unitPrice: number, total: number }>>}
 */
export const ORDER_LINES = new Map(
  ORDERS.map((order) => {
    const count = 1 + random.int(6);
    const lines = Array.from({ length: count }, (_unused, index) => {
      const product = random.pick(PRODUCTS);
      const quantity = 1 + random.int(40);
      return {
        line: index + 1,
        sku: product.sku,
        name: product.name,
        quantity,
        unitPrice: product.price,
        total: Number((quantity * product.price).toFixed(2)),
      };
    });
    return /** @type {[string, typeof lines]} */ ([order.id, lines]);
  }),
);

/**
 * Per-order history. Append-only in the same sense the audit log is: a status
 * change through the API adds an entry here.
 *
 * @type {Map<string, Array<{ at: string, actor: string, event: string, detail: string }>>}
 */
export const ORDER_HISTORY = new Map(
  ORDERS.map((order) => [
    order.id,
    [
      { at: recent(2_000 + random.int(40_000)), actor: order.owner, event: 'created', detail: order.channel },
      { at: recent(1_000 + random.int(1_900)), actor: order.owner, event: 'confirmed', detail: order.promisedOn },
    ],
  ]),
);

/* ── Stock movements ──────────────────────────────────────────────────────── */

/**
 * @type {Array<{ id: string, sku: string, warehouse: string, kind: string, quantity: number, at: string, actor: string }>}
 */
export const MOVEMENTS = Array.from({ length: 180 }, (_unused, index) => {
  const product = random.pick(PRODUCTS);
  return {
    id: `MV-${String(index + 1).padStart(5, '0')}`,
    sku: product.sku,
    warehouse: product.warehouse,
    kind: random.pick(['receipt', 'issue', 'transfer', 'adjustment']),
    quantity: 1 + random.int(220),
    at: recent(random.int(4_320)),
    actor: `${random.pick(FIRST_NAMES)} ${random.pick(LAST_NAMES)}`,
  };
});

/* ── Employees ────────────────────────────────────────────────────────────── */

/**
 * @type {Array<{
 *   id: string, name: string, email: string, role: string, team: string,
 *   location: string, hiredOn: string, phone: string, manager: string, status: string,
 * }>}
 */
export const EMPLOYEES = Array.from({ length: 84 }, (_unused, index) => {
  const first = random.pick(FIRST_NAMES);
  const last = random.pick(LAST_NAMES);
  const team = random.pick(TEAMS);
  return {
    id: `EM-${String(index + 1).padStart(4, '0')}`,
    name: `${first} ${last}`,
    email: `${first.toLowerCase()}.${last.toLowerCase()}@meridian.example`,
    role: random.pick(ROLES),
    team: team.name,
    location: random.pick(WAREHOUSES).city,
    hiredOn: day(random.int(3_600)),
    phone: `+39 0${String(2 + random.int(7))} ${String(1_000_000 + random.int(8_999_999))}`,
    manager: '',
    status: random.next() > 0.12 ? 'active' : 'leave',
  };
});

// Managers and headcounts, resolved once the roster exists. A team lead is an
// employee of that team, which no per-row generator can know while generating.
for (const team of TEAMS) {
  const members = EMPLOYEES.filter((employee) => employee.team === team.name);
  const lead = members[0];
  if (lead === undefined) continue;
  team.headcount = members.length;
  team.lead = lead.name;
  for (const member of members) member.manager = lead.name;
}

/* ── Documents and contracts, for the employee detail tabs ────────────────── */

/**
 * @type {Map<string, Array<{ id: string, kind: string, since: string, until: string, hours: number }>>}
 */
export const EMPLOYEE_CONTRACTS = new Map(
  EMPLOYEES.map((employee) => [
    employee.id,
    [
      {
        id: `CT-${employee.id.slice(3)}-1`,
        kind: random.pick(['permanent', 'fixed-term', 'apprenticeship']),
        since: employee.hiredOn,
        until: '',
        hours: random.pick([20, 30, 38, 40]),
      },
    ],
  ]),
);

/**
 * @type {Map<string, Array<{ id: string, name: string, kind: string, size: number, at: string }>>}
 */
export const EMPLOYEE_DOCUMENTS = new Map(
  EMPLOYEES.map((employee) => [
    employee.id,
    Array.from({ length: 1 + random.int(4) }, (_unused, index) => ({
      id: `DOC-${employee.id.slice(3)}-${String(index + 1)}`,
      name: random.pick(['ID card', 'Contract', 'Training record', 'Equipment receipt', 'NDA']),
      kind: random.pick(['pdf', 'pdf', 'png']),
      size: 24_000 + random.int(3_800_000),
      at: recent(random.int(60_000)),
    })),
  ]),
);

/* ── Application users, for Settings ──────────────────────────────────────── */

/**
 * The accounts the Settings section administers. Distinct from EMPLOYEES on
 * purpose: an employee is a person in the HR system, a user is a login, and the
 * two are administered by different people with different permissions.
 *
 * @type {Array<{ id: string, name: string, email: string, role: string, status: string, lastSeen: string, scopes: string[] }>}
 */
export const USERS = Array.from({ length: 14 }, (_unused, index) => {
  const employee = EMPLOYEES[index * 3] ?? EMPLOYEES[index];
  const name = employee?.name ?? `User ${String(index + 1)}`;
  const role = index === 0 ? 'administrator' : random.pick(['operator', 'viewer', 'operator']);
  return {
    id: `US-${String(index + 1).padStart(4, '0')}`,
    name,
    email: employee?.email ?? `user${String(index + 1)}@meridian.example`,
    role,
    status: random.next() > 0.18 ? 'active' : 'suspended',
    lastSeen: recent(random.int(9_000)),
    scopes: scopesForRole(role),
  };
});

/**
 * The audit trail. Written by every mutating endpoint and read by one screen,
 * which is what makes "who changed this" a question the example can answer.
 *
 * @type {Array<{ id: string, at: string, actor: string, action: string, target: string, detail: string }>}
 */
export const AUDIT = Array.from({ length: 26 }, (_unused, index) => ({
  id: `AU-${String(index + 1).padStart(5, '0')}`,
  at: recent(30 + random.int(20_000)),
  actor: random.pick(USERS).name,
  action: random.pick(['order.status', 'user.suspend', 'user.activate', 'product.reorder', 'session.login']),
  target: random.pick(ORDERS).id,
  detail: random.pick(['from confirmed to shipped', 'manual correction', 'bulk import', 'scheduled job']),
}));

/**
 * Which scopes a role carries. The three roles exist so that the shell's guards
 * have something to refuse: a viewer cannot reach `/settings/users` and cannot
 * mount the analytics remote, and both refusals are visible in the UI rather than
 * hypothetical.
 *
 * Every scope listed here is enforced somewhere a user can see. A scope no route
 * guard, no control and no endpoint reads would still be printed on the profile
 * screen and still be announced on the sign-in screen, which is an entitlement the
 * application advertises and does not have — the one thing this list must not do.
 * So the enforcement points are, exhaustively:
 *
 *   sales:read       the orders and customers routes, and their endpoints
 *   sales:write      the order and customer controls, and their endpoints
 *   inventory:read   the three inventory routes and their endpoints
 *   people:read      the employee and team routes and their endpoints
 *   users:read       /settings/users, its tab, and GET /api/admin/users
 *   users:write      the suspend/activate controls and PATCH on the same endpoint
 *   audit:read       /settings/audit, its tab, and GET /api/admin/audit
 *   analytics:read   the analytics remote's mount guard, and its endpoints
 *   analytics:write  the remote's own `host.auth.can()` gate on its export control
 *
 * @param {string} role
 * @returns {string[]}
 */
export function scopesForRole(role) {
  switch (role) {
    case 'administrator':
      return [
        'sales:read', 'sales:write',
        'inventory:read',
        'people:read',
        'users:read', 'users:write',
        'analytics:read', 'analytics:write',
        'audit:read',
      ];
    case 'operator':
      return [
        'sales:read', 'sales:write',
        'inventory:read',
        'people:read',
        'analytics:read',
      ];
    default:
      return ['sales:read', 'inventory:read', 'people:read'];
  }
}

/**
 * @param {string} action
 * @param {string} actor
 * @param {string} target
 * @param {string} detail
 */
export function audit(action, actor, target, detail) {
  AUDIT.unshift({
    id: `AU-${String(AUDIT.length + 1).padStart(5, '0')}`,
    at: new Date().toISOString(),
    actor,
    action,
    target,
    detail,
  });
  if (AUDIT.length > 400) AUDIT.length = 400;
}

/** Distinct values of one order field, for the filter rules that list options. */
export const ORDER_FACETS = Object.freeze({
  status: ORDER_STATUS,
  channel: CHANNELS,
  segment: SEGMENTS,
  category: CATEGORIES,
  role: ROLES,
});
