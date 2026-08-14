/**
 * The API.
 *
 * One function per resource, dispatched from a small table at the bottom. Three
 * things here are worth more than the data they return:
 *
 *  1. **Paging, sorting and filtering happen on this side.** `/api/orders` returns
 *     one page and a total count, so the orders screen is written the way a screen
 *     over a real API is written — `pagination="server"`, one `query-change`
 *     handler, an AbortController per request — rather than the way a demo over a
 *     local array is.
 *  2. **Scopes are enforced here, not only in the router.** A guard hides a screen;
 *     it does not stop a request. Every endpoint below states the scope it needs and
 *     answers 403 without it, which is why the shell's guards can be understood as
 *     usability rather than as the security boundary they are often mistaken for.
 *  3. **401 is real.** Past its access window a request is refused, and the browser's
 *     `authorizedFetch` refreshes through `GET /auth/session` and retries once. See
 *     the header of auth.mjs.
 */

import {
  AUDIT,
  CITIES,
  CONTACT_ROLES,
  CUSTOMERS,
  EMPLOYEES,
  EMPLOYEE_CONTRACTS,
  EMPLOYEE_DOCUMENTS,
  MOVEMENTS,
  ORDERS,
  ORDER_FACETS,
  ORDER_HISTORY,
  ORDER_LINES,
  PRODUCTS,
  TEAMS,
  USERS,
  WAREHOUSES,
  audit,
} from './data.mjs';
import {
  accessFresh,
  csrfValid,
  login,
  logout,
  renew,
  sessionBody,
  sessionOf,
} from './auth.mjs';
import { openStream, publish } from './events.mjs';

/** @import { ServerSession } from './auth.mjs' */
/** @import { IncomingMessage, ServerResponse } from 'node:http' */

/**
 * @param {ServerResponse} response
 * @param {unknown} body
 * @param {number} [status]
 * @param {Record<string, string>} [headers]
 */
function json(response, body, status = 200, headers = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    // Every response here is per-session state. A cached 200 from a previous
    // session is the kind of bug that only appears behind a proxy.
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(payload);
}

/**
 * @param {IncomingMessage} request
 * @returns {Promise<Record<string, unknown>>}
 */
async function readBody(request) {
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.byteLength;
    // A body limit is not paranoia in an example: without one, a stray upload
    // against a development server exhausts the process rather than failing.
    if (size > 64 * 1024) throw new Error('Request body too large.');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed = parseJson(Buffer.concat(chunks).toString('utf8'));
  return typeof parsed === 'object' && parsed !== null
    ? /** @type {Record<string, unknown>} */ (parsed)
    : {};
}

/**
 * `JSON.parse` is declared to return `any`, and that `any` spreads into every caller. An
 * annotated alias returns `unknown` instead, so a request body has to be narrowed rather
 * than trusted — which, for a body that arrived over the network, is the point.
 *
 * @type {(text: string) => unknown}
 */
const parseJson = JSON.parse;

/* ── Query helpers ────────────────────────────────────────────────────────── */

/**
 * @param {URLSearchParams} query
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function number(query, name, fallback) {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * @param {Record<string, unknown>} row
 * @param {string} key
 * @returns {unknown}
 */
function field(row, key) {
  return key.split('.').reduce(
    /** @param {unknown} carry */
    (carry, part) =>
      typeof carry === 'object' && carry !== null
        ? /** @type {Record<string, unknown>} */ (carry)[part]
        : undefined,
    /** @type {unknown} */ (row),
  );
}

/**
 * Sort a copy by one key. Numbers compare numerically, everything else through
 * `localeCompare` with `numeric: true`, which is what makes `SKU-00009` come
 * before `SKU-00010` instead of after it.
 *
 * @template {Record<string, unknown>} T
 * @param {T[]} rows
 * @param {string} key
 * @param {string} direction
 * @returns {T[]}
 */
function sorted(rows, key, direction) {
  if (key === '' || (direction !== 'asc' && direction !== 'desc')) return rows;
  const sign = direction === 'desc' ? -1 : 1;
  return [...rows].sort((left, right) => {
    const a = field(left, key);
    const b = field(right, key);
    if (typeof a === 'number' && typeof b === 'number') return (a - b) * sign;
    return text(a).localeCompare(text(b), undefined, { numeric: true, sensitivity: 'base' }) * sign;
  });
}

/**
 * Free-text search across the given keys, case- and accent-insensitively.
 *
 * @template {Record<string, unknown>} T
 * @param {T[]} rows
 * @param {string} term
 * @param {readonly string[]} keys
 * @returns {T[]}
 */
function searched(rows, term, keys) {
  const needle = fold(term);
  if (needle === '') return rows;
  return rows.filter((row) => keys.some((key) => fold(text(field(row, key))).includes(needle)));
}

/**
 * A field value as text. Anything that is not a scalar is absent rather than
 * `[object Object]`: a row whose field arrived as an object has no text to search or sort by,
 * and pretending otherwise puts the string "[object Object]" into a comparison.
 *
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return String(value);
  return '';
}

/** @param {string} value */
function fold(value) {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
}

/**
 * A half-open day range, `since to until`, exactly as `ui-date-range` stores it —
 * `until` exclusive, because the query behind it is `since <= x < until`.
 *
 * @template {Record<string, unknown>} T
 * @param {T[]} rows
 * @param {string} key
 * @param {string | null} since
 * @param {string | null} until
 * @returns {T[]}
 */
function inRange(rows, key, since, until) {
  if (since === null && until === null) return rows;
  return rows.filter((row) => {
    const value = text(field(row, key));
    if (since !== null && value < since) return false;
    if (until !== null && value >= until) return false;
    return true;
  });
}

/**
 * Every `?name=a&name=b` value, or null when the parameter is absent.
 *
 * @param {URLSearchParams} query
 * @param {string} name
 * @returns {Set<string> | null}
 */
function anyOf(query, name) {
  const values = query.getAll(name).flatMap((value) => value.split(',')).filter((value) => value !== '');
  return values.length === 0 ? null : new Set(values);
}

/**
 * @template {Record<string, unknown>} T
 * @param {T[]} rows
 * @param {number} offset
 * @param {number} limit
 * @returns {{ rows: T[], total: number, offset: number }}
 */
function page(rows, offset, limit) {
  return { rows: rows.slice(offset, offset + limit), total: rows.length, offset };
}

/* ── Customer validation ──────────────────────────────────────────────────── */

/**
 * The rules a customer has to satisfy, checked here because this is the side that
 * cannot be skipped. The screen checks the same ones as the user types, and that
 * duplication is deliberate rather than accidental: the client copy exists to answer
 * within a keystroke, this one exists because a client is not an authority.
 *
 * Two rules have no client counterpart at all — a name and an email address must be
 * unique across the account — because no client holds the data to answer them. They
 * are the reason the response carries per-field codes rather than one message: a
 * screen that can only say "saving failed" cannot put the caret in the field that
 * caused it.
 *
 * A contact's rules are addressed the same way, by a path: `contacts.1.email` names
 * the email of the second contact, which is the string the form's `firstInvalid`
 * produces and the string its `<ui-field name>` carries. Nothing here knows that —
 * dotted paths are just what a nested body is addressed by — but it is why a 422
 * against a repeating row lands under the row that caused it rather than at the top
 * of the screen.
 *
 * Codes, not sentences. `too_short` is resolved to a language by whoever displays it,
 * which is the same rule the rest of this server follows for `status` and `role`.
 *
 * @param {Record<string, unknown>} body
 * @param {string | null} id The customer being updated, excluded from the uniqueness
 *   checks; null when creating.
 * @returns {Record<string, string>} Field name to error code. Empty means valid.
 */
function validateCustomer(body, id) {
  /** @type {Record<string, string>} */
  const fields = {};
  const name = text(body.name).trim();
  const email = text(body.email).trim().toLowerCase();
  const segment = text(body.segment);
  const country = text(body.country);
  const city = text(body.city).trim();
  const owner = text(body.owner).trim();
  const since = text(body.since);
  const notes = text(body.notes);
  const revenue = body.revenue;

  if (name === '') fields.name = 'required';
  else if (name.length < 2) fields.name = 'tooShort';
  else if (name.length > 80) fields.name = 'tooLong';
  else if (CUSTOMERS.some((row) => row.id !== id && row.name.toLowerCase() === name.toLowerCase())) {
    fields.name = 'taken';
  }

  if (email === '') fields.email = 'required';
  else if (!EMAIL.test(email)) fields.email = 'malformed';
  else if (CUSTOMERS.some((row) => row.id !== id && row.email.toLowerCase() === email)) fields.email = 'taken';

  if (segment === '') fields.segment = 'required';
  else if (!ORDER_FACETS.segment.includes(segment)) fields.segment = 'notAllowed';

  if (country === '') fields.country = 'required';
  else if (!CUSTOMER_COUNTRIES.includes(country)) fields.country = 'notAllowed';

  if (city === '') fields.city = 'required';
  else if (city.length > 60) fields.city = 'tooLong';

  if (owner === '') fields.owner = 'required';
  else if (owner.length > 80) fields.owner = 'tooLong';

  if (since === '') fields.since = 'required';
  else if (!/^\d{4}-\d{2}-\d{2}$/u.test(since) || Number.isNaN(Date.parse(since))) fields.since = 'malformed';
  else if (since > new Date().toISOString().slice(0, 10)) fields.since = 'future';

  // Absent is fine and zero is fine; a string that is not a number is not. `undefined`
  // and `''` mean "not given", which is why the check is not a bare `Number()`.
  if (revenue !== undefined && revenue !== null && revenue !== '') {
    const value = Number(revenue);
    if (!Number.isFinite(value)) fields.revenue = 'malformed';
    else if (value < 0) fields.revenue = 'tooSmall';
    else if (value > 1e12) fields.revenue = 'tooLarge';
  }

  if (notes.length > 280) fields.notes = 'tooLong';

  validateContacts(body.contacts, fields);

  return fields;
}

/** As many contacts as one customer may have. */
const CONTACT_LIMIT = 5;

/**
 * The contacts, each addressed by its index.
 *
 * The duplicate rule is the one worth looking at: it is about the *set* of rows and
 * cannot be answered by looking at one, which is why it is reported against the
 * second occurrence rather than against the array. A code against `contacts` itself
 * would be true and useless — there is no control on the screen for "the contacts",
 * so the form would have nowhere to put it and would report it back as unmatched.
 * The over-the-limit rule is exactly that case, kept because the client is not an
 * authority on it even though its Add control stops before here.
 *
 * @param {unknown} value The body's `contacts`, unvalidated.
 * @param {Record<string, string>} fields Written into, by path.
 */
function validateContacts(value, fields) {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) {
    fields.contacts = 'malformed';
    return;
  }
  if (value.length > CONTACT_LIMIT) fields.contacts = 'tooMany';

  /** @type {Set<string>} */
  const seen = new Set();
  // Validated against the same normalisation the store gets, so a value that
  // passes here is the value that is written: trimming in one function and
  // checking the untrimmed original in the other is how a length rule lets
  // through a name the column cannot hold.
  for (const [index, row] of contactsFrom(value).entries()) {
    if (row.name === '') fields[`contacts.${index}.name`] = 'required';
    else if (row.name.length > 80) fields[`contacts.${index}.name`] = 'tooLong';

    if (row.email === '') fields[`contacts.${index}.email`] = 'required';
    else if (!EMAIL.test(row.email)) fields[`contacts.${index}.email`] = 'malformed';
    else if (seen.has(row.email)) fields[`contacts.${index}.email`] = 'duplicate';
    else seen.add(row.email);

    if (row.role === '') fields[`contacts.${index}.role`] = 'required';
    else if (!CONTACT_ROLES.includes(row.role)) fields[`contacts.${index}.role`] = 'notAllowed';
  }
}

/** Deliberately permissive: the server that will actually deliver mail is the only real check. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/u;

/** The countries a customer may be in, which is where this business has warehouses. */
const CUSTOMER_COUNTRIES = [...new Set(WAREHOUSES.map((warehouse) => warehouse.country))].sort((left, right) =>
  left.localeCompare(right),
);

/**
 * The validated body as a customer's writable fields, and nothing else: a client that
 * posts `id`, `openOrders` or a field this server has never heard of gets it dropped
 * here rather than assigned into the store.
 *
 * @param {Record<string, unknown>} body
 */
function customerFrom(body) {
  const revenue = Number(body.revenue);
  return {
    name: text(body.name).trim(),
    email: text(body.email).trim().toLowerCase(),
    segment: text(body.segment),
    city: text(body.city).trim(),
    country: text(body.country),
    since: text(body.since),
    revenue: Number.isFinite(revenue) ? Math.round(revenue) : 0,
    owner: text(body.owner).trim(),
    notes: text(body.notes).trim(),
    contacts: contactsFrom(body.contacts),
  };
}

/**
 * The contacts as three strings each, and nothing a client invented alongside them.
 *
 * @param {unknown} value
 * @returns {Array<{ name: string, email: string, role: string }>}
 */
function contactsFrom(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const row = typeof entry === 'object' && entry !== null ? /** @type {Record<string, unknown>} */ (entry) : {};
    return {
      name: text(row.name).trim(),
      email: text(row.email).trim().toLowerCase(),
      role: text(row.role),
    };
  });
}

/** Next free `CU-nnnn`, by the highest in use rather than by the array length. */
function nextCustomerId() {
  const highest = CUSTOMERS.reduce((carry, row) => Math.max(carry, Number(row.id.slice(3)) || 0), 0);
  return `CU-${String(highest + 1).padStart(4, '0')}`;
}

/* ── Handlers ─────────────────────────────────────────────────────────────── */

/**
 * @typedef {(context: {
 *   request: IncomingMessage,
 *   response: ServerResponse,
 *   url: URL,
 *   session: ServerSession,
 *   params: string[],
 * }) => void | Promise<void>} ApiHandler
 */

/** @type {Array<{ method: string, pattern: RegExp, scope: string | null, handle: ApiHandler }>} */
const ROUTES = [
  /* Dashboard ------------------------------------------------------------- */
  {
    method: 'GET',
    pattern: /^\/api\/dashboard\/summary$/u,
    scope: 'sales:read',
    handle: ({ response }) => {
      const open = ORDERS.filter((order) => order.status === 'confirmed' || order.status === 'draft');
      const shipped = ORDERS.filter((order) => order.status === 'shipped');
      const belowReorder = PRODUCTS.filter((product) => product.stock < product.reorderPoint);
      json(response, {
        generatedAt: new Date().toISOString(),
        kpis: [
          { key: 'openOrders', value: open.length, delta: 0.062, currency: '' },
          {
            key: 'pipeline',
            value: Number(open.reduce((sum, order) => sum + order.total, 0).toFixed(2)),
            delta: 0.031,
            currency: 'EUR',
          },
          { key: 'shipped', value: shipped.length, delta: -0.014, currency: '' },
          { key: 'belowReorder', value: belowReorder.length, delta: 0.11, currency: '' },
        ],
        // The dashboard renders this list with `t()` on `key`, so the words are
        // the shell's and the numbers are the server's. A server that returned
        // sentences would return them in one language.
        alerts: belowReorder.slice(0, 5).map((product) => ({
          key: 'belowReorder',
          sku: product.sku,
          name: product.name,
          stock: product.stock,
          reorderPoint: product.reorderPoint,
        })),
        targets: { quarter: { attained: 0.68, currency: 'EUR', value: 1_840_000 } },
      });
    },
  },

  /* Orders ---------------------------------------------------------------- */
  {
    method: 'GET',
    pattern: /^\/api\/orders$/u,
    scope: 'sales:read',
    handle: ({ response, url }) => {
      const query = url.searchParams;
      let rows = [...ORDERS];
      rows = searched(rows, query.get('q') ?? '', [
        'code',
        'customer',
        'owner',
        'city',
        'comune',
        'status',
        'channel',
      ]);

      const status = anyOf(query, 'status');
      if (status !== null) rows = rows.filter((order) => status.has(order.status));
      const channel = anyOf(query, 'channel');
      if (channel !== null) rows = rows.filter((order) => channel.has(order.channel));
      const city = anyOf(query, 'city');
      if (city !== null) rows = rows.filter((order) => city.has(order.city));
      const customer = anyOf(query, 'customerId');
      if (customer !== null) rows = rows.filter((order) => customer.has(order.customerId));
      // Municipality ids, from the typeahead. Ids rather than names: two towns share
      // a name often enough that filtering on the label is wrong, and the id is what
      // survives in preference storage.
      const comune = anyOf(query, 'comune');
      if (comune !== null) rows = rows.filter((order) => comune.has(order.comuneId));

      rows = inRange(rows, 'placedOn', query.get('placedFrom'), query.get('placedUntil'));
      rows = sorted(rows, query.get('sort') ?? '', query.get('direction') ?? '');

      const pageNumber = Math.max(1, number(query, 'page', 1));
      const pageSize = Math.min(200, Math.max(1, number(query, 'pageSize', 20)));
      json(response, page(rows, (pageNumber - 1) * pageSize, pageSize));
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/orders\/([\w-]+)$/u,
    scope: 'sales:read',
    handle: ({ response, params }) => {
      const order = ORDERS.find((candidate) => candidate.id === params[0]);
      if (order === undefined) return json(response, { error: 'not_found' }, 404);
      const customer = CUSTOMERS.find((candidate) => candidate.id === order.customerId);
      json(response, { ...order, customerDetail: customer ?? null });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/orders\/([\w-]+)\/lines$/u,
    scope: 'sales:read',
    handle: ({ response, params }) => {
      json(response, { rows: ORDER_LINES.get(params[0] ?? '') ?? [] });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/orders\/([\w-]+)\/history$/u,
    scope: 'sales:read',
    handle: ({ response, params }) => {
      const rows = [...(ORDER_HISTORY.get(params[0] ?? '') ?? [])];
      rows.sort((left, right) => right.at.localeCompare(left.at));
      json(response, { rows });
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/orders\/([\w-]+)$/u,
    scope: 'sales:write',
    handle: async ({ request, response, params, session }) => {
      const order = ORDERS.find((candidate) => candidate.id === params[0]);
      if (order === undefined) return json(response, { error: 'not_found' }, 404);
      const body = await readBody(request);
      const status = typeof body.status === 'string' ? body.status : '';
      if (!ORDER_FACETS.status.includes(status)) {
        return json(response, { error: 'invalid_status', allowed: ORDER_FACETS.status }, 422);
      }
      const previous = order.status;
      order.status = status;
      ORDER_HISTORY.get(order.id)?.unshift({
        at: new Date().toISOString(),
        actor: session.name,
        event: 'status',
        detail: `${previous} → ${status}`,
      });
      audit('order.status', session.name, order.id, `${previous} → ${status}`);
      publish('order.status', { id: order.id, code: order.code, status, actor: session.name });
      json(response, order);
    },
  },

  /* Customers ------------------------------------------------------------- */
  {
    method: 'GET',
    pattern: /^\/api\/customers$/u,
    scope: 'sales:read',
    handle: ({ response }) => {
      // Returned whole: 48 rows is a client-pagination screen, and the example
      // needs one of those as much as it needs a server-paginated one.
      json(response, { rows: CUSTOMERS, total: CUSTOMERS.length });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/customers\/([\w-]+)$/u,
    scope: 'sales:read',
    handle: ({ response, params }) => {
      const customer = CUSTOMERS.find((candidate) => candidate.id === params[0]);
      if (customer === undefined) return json(response, { error: 'not_found' }, 404);
      json(response, customer);
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/customers$/u,
    scope: 'sales:write',
    handle: async ({ request, response, session }) => {
      const body = await readBody(request);
      const fields = validateCustomer(body, null);
      if (Object.keys(fields).length > 0) {
        return json(response, { error: 'validation_failed', fields }, 422);
      }
      const customer = { ...customerFrom(body), id: nextCustomerId(), openOrders: 0 };
      CUSTOMERS.push(customer);
      audit('customer.create', session.name, customer.id, customer.name);
      publish('customer.create', { id: customer.id, name: customer.name, actor: session.name });
      json(response, customer, 201);
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/customers\/([\w-]+)$/u,
    scope: 'sales:write',
    handle: async ({ request, response, params, session }) => {
      const customer = CUSTOMERS.find((candidate) => candidate.id === params[0]);
      if (customer === undefined) return json(response, { error: 'not_found' }, 404);
      const body = await readBody(request);
      const fields = validateCustomer(body, customer.id);
      if (Object.keys(fields).length > 0) {
        return json(response, { error: 'validation_failed', fields }, 422);
      }
      Object.assign(customer, customerFrom(body));
      audit('customer.update', session.name, customer.id, customer.name);
      publish('customer.update', { id: customer.id, name: customer.name, actor: session.name });
      json(response, customer);
    },
  },

  /* Inventory ------------------------------------------------------------- */
  {
    method: 'GET',
    pattern: /^\/api\/products$/u,
    scope: 'inventory:read',
    handle: ({ response, url }) => {
      const query = url.searchParams;
      let rows = [...PRODUCTS];
      rows = searched(rows, query.get('q') ?? '', ['sku', 'name', 'category', 'warehouse']);
      const category = anyOf(query, 'category');
      if (category !== null) rows = rows.filter((product) => category.has(product.category));
      const warehouse = anyOf(query, 'warehouse');
      if (warehouse !== null) rows = rows.filter((product) => warehouse.has(product.warehouse));
      if (query.get('belowReorder') === 'true') {
        rows = rows.filter((product) => product.stock < product.reorderPoint);
      }
      rows = sorted(rows, query.get('sort') ?? '', query.get('direction') ?? '');
      // Offset/limit rather than page/pageSize: this screen appends pages instead
      // of replacing them, and an offset is what "append from here" means.
      const offset = Math.max(0, number(query, 'offset', 0));
      const limit = Math.min(200, Math.max(1, number(query, 'limit', 25)));
      json(response, page(rows, offset, limit));
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/movements$/u,
    scope: 'inventory:read',
    handle: ({ response, url }) => {
      const rows = sorted([...MOVEMENTS], 'at', 'desc');
      json(response, page(rows, 0, Math.min(500, number(url.searchParams, 'limit', 120))));
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/warehouses$/u,
    scope: 'inventory:read',
    handle: ({ response }) => {
      json(response, {
        rows: WAREHOUSES.map((warehouse) => {
          const stock = PRODUCTS.filter((product) => product.warehouse === warehouse.id);
          return {
            ...warehouse,
            skus: stock.length,
            units: stock.reduce((sum, product) => sum + product.stock, 0),
            alerts: stock.filter((product) => product.stock < product.reorderPoint).length,
          };
        }),
      });
    },
  },

  /* People ---------------------------------------------------------------- */
  {
    method: 'GET',
    pattern: /^\/api\/employees$/u,
    scope: 'people:read',
    handle: ({ response }) => {
      json(response, { rows: EMPLOYEES, total: EMPLOYEES.length });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/employees\/([\w-]+)$/u,
    scope: 'people:read',
    handle: ({ response, params }) => {
      const employee = EMPLOYEES.find((candidate) => candidate.id === params[0]);
      if (employee === undefined) return json(response, { error: 'not_found' }, 404);
      json(response, employee);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/employees\/([\w-]+)\/contracts$/u,
    scope: 'people:read',
    handle: ({ response, params }) => {
      json(response, { rows: EMPLOYEE_CONTRACTS.get(params[0] ?? '') ?? [] });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/employees\/([\w-]+)\/documents$/u,
    scope: 'people:read',
    handle: ({ response, params }) => {
      json(response, { rows: EMPLOYEE_DOCUMENTS.get(params[0] ?? '') ?? [] });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/teams$/u,
    scope: 'people:read',
    handle: ({ response }) => {
      json(response, { rows: TEAMS });
    },
  },

  /* Lookups --------------------------------------------------------------- */
  {
    method: 'GET',
    pattern: /^\/api\/lookups\/cities$/u,
    scope: 'sales:read',
    handle: ({ response, url }) => {
      const query = url.searchParams;
      const ids = anyOf(query, 'id');
      if (ids !== null) {
        // Resolving persisted values by id, which is what a `typeahead` rule's
        // `resolve` needs on load: without it a filter the user left switched on
        // has no label and is dropped.
        json(response, { rows: CITIES.filter((city) => ids.has(city.id)) });
        return;
      }
      const term = fold(query.get('q') ?? '');
      const limit = Math.min(50, Math.max(1, number(query, 'limit', 20)));
      /** @type {typeof CITIES[number][]} */
      const rows = [];
      // A bounded scan rather than filter-then-slice: the whole reason this
      // endpoint exists is that the list is too big to hand over, so it is also
      // too big to copy on every keystroke.
      for (const city of CITIES) {
        if (term !== '' && !fold(city.name).includes(term)) continue;
        rows.push(city);
        if (rows.length === limit) break;
      }
      json(response, { rows, total: rows.length });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/lookups\/([\w-]+)$/u,
    scope: 'sales:read',
    handle: ({ response, params }) => {
      const name = params[0] ?? '';
      /** @type {Record<string, readonly string[]>} */
      const lists = {
        status: ORDER_FACETS.status,
        channel: ORDER_FACETS.channel,
        segment: ORDER_FACETS.segment,
        category: ORDER_FACETS.category,
        role: ORDER_FACETS.role,
        city: [...new Set(CUSTOMERS.map((customer) => customer.city))].sort((a, b) => a.localeCompare(b)),
        country: CUSTOMER_COUNTRIES,
        team: TEAMS.map((team) => team.name),
        location: [...new Set(EMPLOYEES.map((employee) => employee.location))].sort((a, b) => a.localeCompare(b)),
        warehouse: WAREHOUSES.map((warehouse) => warehouse.id),
      };
      const values = lists[name];
      if (values === undefined) return json(response, { error: 'not_found' }, 404);
      json(response, { rows: values.map((value) => ({ value, label: value })) });
    },
  },

  /* Settings -------------------------------------------------------------- */
  {
    method: 'GET',
    pattern: /^\/api\/users$/u,
    scope: 'users:read',
    handle: ({ response }) => {
      json(response, { rows: USERS.map(({ scopes, ...user }) => ({ ...user, scopeCount: scopes.length })) });
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/users\/([\w-]+)$/u,
    scope: 'users:write',
    handle: async ({ request, response, params, session }) => {
      const user = USERS.find((candidate) => candidate.id === params[0]);
      if (user === undefined) return json(response, { error: 'not_found' }, 404);
      const body = await readBody(request);
      const status = typeof body.status === 'string' ? body.status : '';
      if (status !== 'active' && status !== 'suspended') {
        return json(response, { error: 'invalid_status', allowed: ['active', 'suspended'] }, 422);
      }
      user.status = status;
      audit(status === 'active' ? 'user.activate' : 'user.suspend', session.name, user.id, user.email);
      publish('user.status', { id: user.id, status, actor: session.name });
      json(response, user);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/audit$/u,
    scope: 'audit:read',
    handle: ({ response, url }) => {
      json(response, page(AUDIT, 0, Math.min(400, number(url.searchParams, 'limit', 80))));
    },
  },

  /* The analytics remote's only endpoint ---------------------------------- */
  {
    method: 'GET',
    pattern: /^\/api\/analytics\/summary$/u,
    scope: 'analytics:read',
    handle: ({ response }) => {
      const byChannel = ORDER_FACETS.channel.map((channel) => {
        const rows = ORDERS.filter((order) => order.channel === channel);
        return {
          channel,
          orders: rows.length,
          value: Number(rows.reduce((sum, order) => sum + order.total, 0).toFixed(2)),
        };
      });
      json(response, {
        generatedAt: new Date().toISOString(),
        currency: 'EUR',
        byChannel,
        conversion: 0.41,
      });
    },
  },

  /* Live events ----------------------------------------------------------- */
  {
    method: 'GET',
    pattern: /^\/api\/events$/u,
    scope: 'sales:read',
    handle: ({ request, response }) => {
      openStream(request, response);
    },
  },
];

/**
 * @param {IncomingMessage} request
 * @param {ServerResponse} response
 * @param {URL} url
 * @returns {Promise<boolean>} Whether this module answered the request.
 */
export async function handleApi(request, response, url) {
  const method = (request.method ?? 'GET').toUpperCase();
  const path = url.pathname;

  /* ── /auth: the three endpoints the BFF store expects ─────────────────── */

  if (path === '/auth/login' && method === 'POST') {
    const result = login(await readBody(request));
    if (result === null) {
      json(response, { error: 'invalid_credentials' }, 401);
      return true;
    }
    json(response, sessionBody(result.session), 200, { 'Set-Cookie': result.cookie });
    return true;
  }

  if (path === '/auth/login' && method === 'DELETE') {
    const cookie = logout(request);
    response.writeHead(204, { 'Set-Cookie': cookie, 'Cache-Control': 'no-store' });
    response.end();
    return true;
  }

  if (path === '/auth/session' && method === 'GET') {
    const session = sessionOf(request);
    if (session === null) {
      json(response, { error: 'no_session' }, 401);
      return true;
    }
    // This is what the store calls `refresh()`. The BFF renews behind the cookie
    // and the browser learns only when the next renewal is due.
    json(response, sessionBody(renew(session)));
    return true;
  }

  if (!path.startsWith('/api/')) return false;

  /* ── Everything under /api: session, freshness, CSRF, scope ──────────── */

  const session = sessionOf(request);
  if (session === null) {
    json(response, { error: 'no_session' }, 401);
    return true;
  }

  if (!accessFresh(session)) {
    // The gap a real BFF has between its access token expiring and the next
    // refresh. `authorizedFetch` handles exactly this: refresh once, retry once.
    json(response, { error: 'token_expired' }, 401);
    return true;
  }

  if (!csrfValid(request, session)) {
    json(response, { error: 'csrf_failed' }, 403);
    return true;
  }

  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(path);
    if (match === null) continue;
    if (route.scope !== null && !session.scopes.includes(route.scope)) {
      json(response, { error: 'insufficient_scope', required: route.scope }, 403);
      return true;
    }
    await route.handle({
      request,
      response,
      url,
      session,
      params: match.slice(1).map((value) => value ?? ''),
    });
    return true;
  }

  const allowed = ROUTES.filter((route) => route.pattern.test(path)).map((route) => route.method);
  if (allowed.length > 0) {
    json(response, { error: 'method_not_allowed', allowed }, 405, { Allow: allowed.join(', ') });
    return true;
  }

  json(response, { error: 'not_found' }, 404);
  return true;
}
