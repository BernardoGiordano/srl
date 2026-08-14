/**
 * The browser suite's stand-in for `example/server/`.
 *
 * This application is the one with a real backend, which is the whole point of it — so a
 * stub here needs justifying rather than assuming. The reason is what the runner is: it
 * serves the repository's files over one origin and runs the suite inside the page. It is
 * not the application's server, and pointing the suite at a separately started Node process
 * would make `npm test` depend on a second thing being up, in the right state, on the right
 * port.
 *
 * So the boundary that is faked is the one the framework says to fake: HTTP, and nothing
 * else. The router is real, the guards are real, the session is real, the components are
 * real, and every response below is a real HTTP shape — a `Set-Cookie` cannot be faked from
 * JavaScript, so `sessionOf` is a variable instead, and that is the one place this diverges
 * from the server it stands in for.
 *
 * What it does reproduce, because the suite asserts on it:
 *
 *   - the three `/auth` endpoints the BFF token store expects, including a CSRF token;
 *   - 403 for a scope the session does not carry, so the guard tests are not the only thing
 *     keeping a viewer out;
 *   - one 401 followed by success, so `authorizedFetch`'s refresh-and-retry is exercised
 *     rather than described;
 *   - server-side paging on `/api/orders`, because the orders screen is written against it.
 */

/** @typedef {{ username: string, name: string, role: string, scopes: string[], csrf: string }} FakeSession */

const ORDERS = Array.from({ length: 45 }, (_unused, index) => ({
  id: `OR-${String(index + 1).padStart(5, '0')}`,
  code: `2026-${String(index + 1).padStart(5, '0')}`,
  customerId: 'CU-0001',
  customer: index % 2 === 0 ? 'Aurora Utilities' : 'Borealis Logistics',
  status: index % 3 === 0 ? 'confirmed' : 'shipped',
  channel: 'direct',
  placedOn: `2026-0${(index % 9) + 1}-14`,
  promisedOn: `2026-0${(index % 9) + 1}-28`,
  currency: 'EUR',
  total: 1000 + index * 25,
  owner: 'Ada Rossi',
  city: 'Milano',
  comuneId: 'C00001',
  comune: 'Aurora 1',
}));

/**
 * The one mutable resource here, because it is the only one the suite writes to. Reset
 * by `installFakeServer`, so a case that creates a customer cannot leave it for the next.
 *
 * @type {Array<Record<string, unknown> & { id: string, name: string, email: string }>}
 */
let CUSTOMERS = [];

/** @returns {typeof CUSTOMERS} */
function initialCustomers() {
  return [
    {
      id: 'CU-0001',
      name: 'Aurora Utilities',
      email: 'aurora.utilities@example.com',
      segment: 'enterprise',
      city: 'Milano',
      country: 'IT',
      since: '2023-04-01',
      openOrders: 3,
      revenue: 480_000,
      owner: 'Ada Rossi',
      notes: '',
      // One contact rather than none, so a case that loads this customer meets a
      // populated array and a case that adds to it meets a second row.
      contacts: [{ name: 'Grace Bianchi', email: 'grace.bianchi@example.com', role: 'billing' }],
    },
    {
      id: 'CU-0002',
      name: 'Borealis Logistics',
      email: 'borealis.logistics@example.com',
      segment: 'midmarket',
      city: 'Berlin',
      country: 'DE',
      since: '2024-02-11',
      openOrders: 1,
      revenue: 120_000,
      owner: 'Ada Rossi',
      notes: '',
      contacts: [],
    },
  ];
}

const SCOPES = {
  administrator: [
    'sales:read',
    'sales:write',
    'inventory:read',
    'people:read',
    'users:read',
    'users:write',
    'analytics:read',
    'analytics:write',
    'audit:read',
  ],
  viewer: ['sales:read', 'inventory:read', 'people:read'],
};

/** @type {FakeSession | null} */
let session = null;

/** Set to make the next `/api` call answer 401 once, as an expired access token would. */
let expireOnce = false;

/** Every path the suite has seen, so a test can assert something was *not* fetched. */
/** @type {string[]} */
export const requested = [];

/** @type {typeof fetch | undefined} */
let realFetch;

/** Install the stub. Returns the function that removes it again. */
export function installFakeServer() {
  realFetch ??= globalThis.fetch;
  session = null;
  expireOnce = false;
  requested.length = 0;
  CUSTOMERS = initialCustomers();

  globalThis.fetch = /** @type {typeof fetch} */ (
    async (input, init) => {
      // `authorizedFetch` sends a `Request`, not a URL string: a store may have to add a
      // header, and a Request is the only thing that carries one. `String(request)` is
      // "[object Request]", which is how a stub ends up faking an endpoint nobody called.
      const target = input instanceof Request ? input.url : String(input);
      const url = new URL(target, location.origin);
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      requested.push(`${method} ${url.pathname}`);

      // Read here rather than in `answer`, because a `Request` body is a stream and
      // reading it is asynchronous — this is the only layer that can await. The clone
      // leaves the original intact for the calls that fall through to the real fetch.
      const body =
        input instanceof Request
          ? await input.clone().text()
          : typeof init?.body === 'string'
            ? init.body
            : '';

      const handled = answer(url, method, body);
      if (handled !== undefined) return handled;

      // Anything else — templates, translations, the manifest — is a real file on this
      // origin and is fetched for real. A stub that answered those would be testing itself.
      return present(realFetch)(input, init);
    }
  );

  return () => {
    if (realFetch !== undefined) globalThis.fetch = realFetch;
    session = null;
  };
}

/** Make the next `/api` request answer 401, once. */
export function expireAccessToken() {
  expireOnce = true;
}

/** @returns {FakeSession | null} */
export function currentSession() {
  return session;
}

/**
 * @param {URL} url
 * @param {string} method
 * @param {string} bodyText The request body, already read. Empty for a GET.
 * @returns {Response | undefined}
 */
function answer(url, method, bodyText) {
  const path = url.pathname;

  if (path === '/auth/login' && method === 'POST') {
    const body = readCredentials(bodyText);
    const role = body.password === 'admin' ? 'administrator' : body.password === 'viewer' ? 'viewer' : null;
    if (role === null || body.username === '') return json({ error: 'invalid_credentials' }, 401);
    session = {
      username: body.username,
      name: 'Ada Rossi',
      role,
      scopes: [...SCOPES[role === 'administrator' ? 'administrator' : 'viewer']],
      csrf: 'test-csrf',
    };
    return json(sessionBody(session));
  }

  if (path === '/auth/login' && method === 'DELETE') {
    session = null;
    return new Response(null, { status: 204 });
  }

  if (path === '/auth/session' && method === 'GET') {
    if (session === null) return json({ error: 'no_session' }, 401);
    // The BFF renewing behind the cookie. This is what clears the 401 the retry hit.
    expireOnce = false;
    return json(sessionBody(session));
  }

  if (!path.startsWith('/api/')) return undefined;

  if (session === null) return json({ error: 'no_session' }, 401);
  if (expireOnce) {
    expireOnce = false;
    return json({ error: 'token_expired' }, 401);
  }

  /** @param {string} scope */
  const refuse = (scope) =>
    session !== null && !session.scopes.includes(scope)
      ? json({ error: 'insufficient_scope', required: scope }, 403)
      : undefined;

  if (path === '/api/dashboard/summary') {
    return (
      refuse('sales:read') ??
      json({
        generatedAt: new Date().toISOString(),
        kpis: [
          { key: 'openOrders', value: 12, delta: 0.05, currency: '' },
          { key: 'pipeline', value: 48_250.5, delta: 0.02, currency: 'EUR' },
          { key: 'shipped', value: 30, delta: -0.01, currency: '' },
          { key: 'belowReorder', value: 4, delta: 0.1, currency: '' },
        ],
        alerts: [{ key: 'belowReorder', sku: 'SKU-00001', name: 'Router Aurora 100', stock: 3, reorderPoint: 40 }],
        targets: { quarter: { attained: 0.5, currency: 'EUR', value: 100_000 } },
      })
    );
  }

  if (path === '/api/orders') {
    const denied = refuse('sales:read');
    if (denied !== undefined) return denied;
    const page = Number(url.searchParams.get('page') ?? '1');
    const pageSize = Number(url.searchParams.get('pageSize') ?? '20');
    const term = (url.searchParams.get('q') ?? '').toLowerCase();
    const matches = term === '' ? ORDERS : ORDERS.filter((order) => order.customer.toLowerCase().includes(term));
    const offset = (page - 1) * pageSize;
    return json({ rows: matches.slice(offset, offset + pageSize), total: matches.length, offset });
  }

  const orderId = /^\/api\/orders\/([\w-]+)$/u.exec(path)?.[1];
  if (orderId !== undefined && method === 'GET') {
    const order = ORDERS.find((candidate) => candidate.id === orderId);
    if (order === undefined) return json({ error: 'not_found' }, 404);
    return refuse('sales:read') ?? json({ ...order, customerDetail: null });
  }

  const linesId = /^\/api\/orders\/([\w-]+)\/lines$/u.exec(path)?.[1];
  if (linesId !== undefined) {
    return (
      refuse('sales:read') ??
      json({
        rows: [{ line: 1, sku: 'SKU-00001', name: 'Router Aurora 100', quantity: 2, unitPrice: 500, total: 1000 }],
      })
    );
  }

  if (/^\/api\/orders\/[\w-]+\/history$/u.test(path)) {
    return (
      refuse('sales:read') ??
      json({ rows: [{ at: new Date().toISOString(), actor: 'Ada Rossi', event: 'created', detail: 'direct' }] })
    );
  }

  if (path === '/api/users') return refuse('users:read') ?? json({ rows: [] });
  if (path === '/api/audit') return refuse('audit:read') ?? json({ rows: [], total: 0 });
  if (path === '/api/employees') return refuse('people:read') ?? json({ rows: [], total: 0 });
  if (path === '/api/products') return refuse('inventory:read') ?? json({ rows: [], total: 0, offset: 0 });

  /*
   * Customers, including the write path.
   *
   * The 422 shape is reproduced rather than simplified, because it is what the form is
   * written against: a per-field code the screen resolves to a sentence and places under
   * the field. Uniqueness is the rule worth having here — it is the one no client can
   * check, so it is the one that proves the round trip is what puts the error on screen.
   */
  if (path === '/api/customers' && method === 'GET') {
    return refuse('sales:read') ?? json({ rows: CUSTOMERS, total: CUSTOMERS.length });
  }

  if (path === '/api/customers' && method === 'POST') {
    const denied = refuse('sales:write');
    if (denied !== undefined) return denied;
    const body = readJson(bodyText);
    const invalid = validateCustomer(body, null);
    if (invalid !== undefined) return json({ error: 'validation_failed', fields: invalid }, 422);
    // `validateCustomer` has already established that name and email are non-empty
    // strings; the annotation is what carries that to the array's element type.
    const created = {
      ...body,
      id: `CU-${String(CUSTOMERS.length + 1).padStart(4, '0')}`,
      name: String(body.name),
      email: String(body.email),
      openOrders: 0,
    };
    CUSTOMERS.push(created);
    return json(created, 201);
  }

  const customerId = /^\/api\/customers\/([\w-]+)$/u.exec(path)?.[1];
  if (customerId !== undefined) {
    const customer = CUSTOMERS.find((candidate) => candidate.id === customerId);
    if (method === 'GET') {
      const denied = refuse('sales:read');
      if (denied !== undefined) return denied;
      return customer === undefined ? json({ error: 'not_found' }, 404) : json(customer);
    }
    if (method === 'PATCH') {
      const denied = refuse('sales:write');
      if (denied !== undefined) return denied;
      if (customer === undefined) return json({ error: 'not_found' }, 404);
      const body = readJson(bodyText);
      const invalid = validateCustomer(body, customerId);
      if (invalid !== undefined) return json({ error: 'validation_failed', fields: invalid }, 422);
      Object.assign(customer, body);
      return json(customer);
    }
  }

  if (path === '/api/lookups/country') {
    return (
      refuse('sales:read') ??
      json({ rows: [{ value: 'DE', label: 'DE' }, { value: 'IT', label: 'IT' }, { value: 'NL', label: 'NL' }] })
    );
  }
  if (path.startsWith('/api/lookups/')) return refuse('sales:read') ?? json({ rows: [] });

  return json({ rows: [], total: 0 });
}

/**
 * @param {FakeSession} value
 */
function sessionBody(value) {
  return {
    sub: value.username,
    name: value.name,
    scopes: value.scopes,
    // Far enough out that AuthSession's refresh timer does not fire during the suite: a
    // timer going off mid-test is a flake nobody enjoys finding.
    expiresAt: Date.now() + 3_600_000,
    csrfToken: value.csrf,
    role: value.role,
  };
}

/**
 * @param {unknown} body
 * @param {number} [status]
 * @returns {Response}
 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * @param {string} bodyText
 * @returns {Record<string, unknown>}
 */
function readJson(bodyText) {
  const parsed = parseJson(bodyText === '' ? '{}' : bodyText);
  return typeof parsed === 'object' && parsed !== null ? /** @type {Record<string, unknown>} */ (parsed) : {};
}

/**
 * @param {string} bodyText
 * @returns {{ username: string, password: string }}
 */
function readCredentials(bodyText) {
  const record = readJson(bodyText);
  return {
    username: typeof record.username === 'string' ? record.username : '',
    password: typeof record.password === 'string' ? record.password : '',
  };
}

/**
 * The rules the customer form is written against, reproduced far enough to be worth
 * asserting on: the fields that must be present, one format, and the uniqueness checks
 * no client can perform. Codes, never sentences — the screen resolves them.
 *
 * The contact rules are addressed by path — `contacts.1.email` — because that is the
 * shape the real server answers with and the shape the form resolves. `duplicate` is
 * the one worth reproducing: it is about the *set* of rows, so it is the rule that
 * proves a 422 against a repeating row lands under the right row.
 *
 * @param {Record<string, unknown>} body
 * @param {string | null} id The row being updated, excluded from uniqueness.
 * @returns {Record<string, string> | undefined} Undefined when the body is acceptable.
 */
function validateCustomer(body, id) {
  /** @type {Record<string, string>} */
  const fields = {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';

  for (const key of ['name', 'email', 'segment', 'country', 'city', 'owner', 'since']) {
    if (typeof body[key] !== 'string' || body[key] === '') fields[key] = 'required';
  }

  if (fields.name === undefined && CUSTOMERS.some((row) => row.id !== id && row.name.toLowerCase() === name.toLowerCase())) {
    fields.name = 'taken';
  }
  if (fields.email === undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/u.test(email)) fields.email = 'malformed';
  else if (fields.email === undefined && CUSTOMERS.some((row) => row.id !== id && row.email.toLowerCase() === email)) {
    fields.email = 'taken';
  }

  const contacts = Array.isArray(body.contacts) ? body.contacts : [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const [index, entry] of contacts.entries()) {
    const row = typeof entry === 'object' && entry !== null ? /** @type {Record<string, unknown>} */ (entry) : {};
    for (const key of ['name', 'email', 'role']) {
      if (typeof row[key] !== 'string' || row[key] === '') fields[`contacts.${index}.${key}`] = 'required';
    }
    const address = typeof row.email === 'string' ? row.email.trim().toLowerCase() : '';
    if (address === '') continue;
    if (seen.has(address)) fields[`contacts.${index}.email`] = 'duplicate';
    else seen.add(address);
  }

  return Object.keys(fields).length === 0 ? undefined : fields;
}

/** @type {(text: string) => unknown} */
const parseJson = JSON.parse;

/**
 * @template T
 * @param {T | undefined} value
 * @returns {T}
 */
function present(value) {
  if (value === undefined) throw new Error('The real fetch was not captured.');
  return value;
}

/**
 * `EventSource` has no server to connect to under the runner, and an unstubbed one retries
 * every three seconds for the length of the suite. This stands in for it: it opens, and it
 * never delivers an event, which is exactly the state the screens render as "reconnecting".
 *
 * @returns {() => void} Restores the real constructor.
 */
export function installFakeEventSource() {
  const real = globalThis.EventSource;

  class FakeEventSource extends EventTarget {
    /** @type {((event: Event) => void) | null} */
    onopen = null;

    /** @type {((event: Event) => void) | null} */
    onerror = null;

    /** @param {string | URL} url */
    constructor(url) {
      super();
      this.url = String(url);
      this.readyState = 1;
      // `LiveFeed` assigns `onopen` rather than adding a listener, so the handler is called
      // directly: dispatching an event would not reach a property nothing listens for.
      setTimeout(() => this.onopen?.(new Event('open')), 0);
    }

    close() {
      this.readyState = 2;
    }
  }

  globalThis.EventSource = /** @type {typeof EventSource} */ (
    /** @type {unknown} */ (FakeEventSource)
  );
  return () => {
    globalThis.EventSource = real;
  };
}
