/**
 * The browser suite's stand-in for `example/server/`.
 *
 * This application is the one with a real backend, so a stub here needs justifying
 * rather than assuming. The reason is what the runner is. It serves the repository's
 * files over one origin and runs the suite inside the page. It is not the application's
 * server, and pointing the suite at a separately started Node process would make
 * `npm test` depend on a second thing being up, in the right state, on the right port.
 *
 * The boundary that is faked is the one the framework says to fake, which is HTTP and
 * nothing else. The router is real, the guards are real, the session is real, the
 * components are real, and every response below is a real HTTP shape. A `Set-Cookie`
 * cannot be faked from JavaScript, so `sessionOf` is a variable instead, and that is the
 * one place this diverges from the server it stands in for.
 *
 * What it does reproduce, because the suite asserts on it:
 *
 *   - the three `/auth` endpoints the BFF token store expects, including a CSRF token;
 *   - 403 for a scope the session does not carry, so the guard tests are not the only thing
 *     keeping a viewer out;
 *   - one 401 followed by success, so `authorizedFetch`'s refresh-and-retry is exercised
 *     rather than described;
 *   - server-side paging on `/api/orders`, because the orders screen is written against it;
 *   - a persisted order-status write, so shared record refresh is exercised end to end;
 *   - 120 stock movements, so the movements screen's window has more rows than it
 *     renders and the journey suite can scroll one.
 */

/** @typedef {{ username: string, name: string, role: string, scopes: string[], csrf: string }} FakeSession */

function initialOrders() {
  return Array.from({ length: 45 }, (_unused, index) => {
    const aurora = index % 2 === 0;
    return {
      id: `OR-${String(index + 1).padStart(5, '0')}`,
      code: `2026-${String(index + 1).padStart(5, '0')}`,
      customerId: aurora ? 'CU-0001' : 'CU-0002',
      customer: aurora ? 'Aurora Utilities' : 'Borealis Logistics',
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
    };
  });
}

let ORDERS = initialOrders();

/**
 * Stock movements, deterministic and long enough that a window leaves most of them out
 * of the DOM. The screen asks for 120 and renders about a dozen at a time, so a suite
 * that only ever saw the first page would never touch the arithmetic that maps a scroll
 * position to a row index.
 */
function initialMovements() {
  const kinds = ['receipt', 'issue', 'transfer', 'adjustment'];
  return Array.from({ length: 120 }, (_unused, index) => ({
    id: `MV-${String(index + 1).padStart(5, '0')}`,
    kind: /** @type {string} */ (kinds[index % kinds.length]),
    sku: `SKU-${String((index % 12) + 1).padStart(5, '0')}`,
    warehouse: index % 2 === 0 ? 'Milano' : 'Bologna',
    quantity: ((index % 9) + 1) * 5,
    at: `2026-09-${String((index % 28) + 1).padStart(2, '0')}T08:${String(index % 60).padStart(2, '0')}:00.000Z`,
    actor: index % 3 === 0 ? 'Ada Rossi' : 'Beniamino Conti',
  }));
}

const MOVEMENTS = initialMovements();

/**
 * Customers are reset by `installFakeServer`, so a case that creates or edits one cannot
 * leave it for the next.
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

/**
 * Accounts, mutable because the Settings screen writes to them. Three rows rather than
 * one, so a bulk action has something to leave alone.
 *
 * @type {Array<{ id: string, name: string, email: string, role: string, status: string, lastSeen: string, scopeCount: number }>}
 */
let USERS = [];

/** @returns {typeof USERS} */
function initialUsers() {
  return [
    { id: 'US-0001', name: 'Ada Rossi', email: 'ada@example.com', role: 'administrator', status: 'active', lastSeen: '2026-09-09T08:00:00.000Z', scopeCount: 9 },
    { id: 'US-0002', name: 'Grace Bianchi', email: 'grace@example.com', role: 'viewer', status: 'active', lastSeen: '2026-09-08T08:00:00.000Z', scopeCount: 3 },
    { id: 'US-0003', name: 'Linus Verdi', email: 'linus@example.com', role: 'viewer', status: 'active', lastSeen: '2026-09-07T08:00:00.000Z', scopeCount: 3 },
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

/**
 * Install the stub. Returns the function that removes it again.
 *
 * `origin` is for the caller that has no `location`: the benchmark harness imports this
 * module into Node and drives it from `tools/benchmark/origin.mjs`, so that the artifact
 * workloads walk this application's real routes against the same backend its browser
 * suite asserts on. Omitted in the browser, where the page's own origin is the answer.
 *
 * @param {{ origin?: string }} [options]
 * @returns {() => void}
 */
export function installFakeServer(options = {}) {
  const base = options.origin ?? globalThis.location?.origin;
  realFetch ??= globalThis.fetch;
  session = null;
  expireOnce = false;
  requested.length = 0;
  ORDERS = initialOrders();
  CUSTOMERS = initialCustomers();
  USERS = initialUsers();

  globalThis.fetch = /** @type {typeof fetch} */ (
    async (input, init) => {
      // `authorizedFetch` sends a `Request`, not a URL string: a store may have to add a
      // header, and a Request is the only thing that carries one. `String(request)` is
      // "[object Request]", which is how a stub ends up faking an endpoint nobody called.
      const target = input instanceof Request ? input.url : String(input);
      const url = new URL(target, base);
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      requested.push(`${method} ${url.pathname}`);

      // Read here rather than in `answer`, because a `Request` body is a stream and
      // reading it is asynchronous, and this is the only layer that can await. The
      // clone leaves the original intact for the calls that fall through to the real
      // fetch.
      const body =
        input instanceof Request
          ? await input.clone().text()
          : typeof init?.body === 'string'
            ? init.body
            : '';

      const handled = answer(url, method, body);
      if (handled !== undefined) return handled;

      // Anything else, such as templates, translations and the manifest, is a real
      // file on this origin and is fetched for real. A stub that answered those would
      // be testing itself.
      return present(realFetch)(input, init);
    }
  );

  return () => {
    if (realFetch !== undefined) globalThis.fetch = realFetch;
    session = null;
  };
}

/**
 * Sign the stub in, for a benchmark that measures an authenticated route.
 *
 * Separate from `installFakeServer` because a credential is the one thing the harness
 * must not guess: it knows how to ask for an authenticated origin, and this module is
 * the only place that knows what this application's sign-in looks like. `admin` is the
 * password `/auth/login` above turns into the administrator scope set, so a route guard
 * on a leaf is satisfied by a real session rather than by a bypass.
 *
 * @param {typeof globalThis.fetch} fetch The stub's fetch, captured while it was installed.
 * @param {string} origin
 * @returns {Promise<void>}
 */
export async function benchmarkSignIn(fetch, origin) {
  const response = await fetch(`${origin}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'ada.rossi', password: 'admin' }),
  });
  if (!response.ok) {
    throw new Error(`the fake server refused the benchmark sign-in with ${String(response.status)}.`);
  }
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
    const customer = CUSTOMERS.find((candidate) => candidate.id === order.customerId);
    return refuse('sales:read') ?? json({ ...order, customerDetail: customer ?? null });
  }

  if (orderId !== undefined && method === 'PATCH') {
    const denied = refuse('sales:write');
    if (denied !== undefined) return denied;
    const order = ORDERS.find((candidate) => candidate.id === orderId);
    if (order === undefined) return json({ error: 'not_found' }, 404);
    const status = readJson(bodyText).status;
    if (typeof status !== 'string') return json({ error: 'invalid_status' }, 422);
    order.status = status;
    return json(order);
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

  if (path === '/api/users') return refuse('users:read') ?? json({ rows: USERS });

  const userId = /^\/api\/users\/([\w-]+)$/u.exec(path)?.[1];
  if (userId !== undefined && method === 'PATCH') {
    const denied = refuse('users:write');
    if (denied !== undefined) return denied;
    const user = USERS.find((candidate) => candidate.id === userId);
    if (user === undefined) return json({ error: 'not_found' }, 404);
    const status = readJson(bodyText).status;
    if (status === 'active' || status === 'suspended') user.status = status;
    return json(user);
  }
  if (path === '/api/audit') return refuse('audit:read') ?? json({ rows: [], total: 0 });
  if (path === '/api/employees') return refuse('people:read') ?? json({ rows: [], total: 0 });
  if (path === '/api/products') return refuse('inventory:read') ?? json({ rows: [], total: 0, offset: 0 });

  if (path === '/api/movements') {
    const denied = refuse('inventory:read');
    if (denied !== undefined) return denied;
    const limit = Number(url.searchParams.get('limit') ?? MOVEMENTS.length);
    const rows = MOVEMENTS.slice(0, Number.isFinite(limit) && limit > 0 ? limit : MOVEMENTS.length);
    return json({ rows, total: MOVEMENTS.length });
  }

  /*
   * Customers, including the write path.
   *
   * The 422 shape is reproduced rather than simplified, because it is what the form is
   * written against, a per-field code the screen resolves to a sentence and places under
   * the field. Uniqueness is the rule worth having here, because it is the one no client
   * can check and therefore the one that proves the round trip is what puts the error on
   * screen.
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

  /*
   * The uniqueness rule again, asked while the user types rather than at submit.
   * Above the by-id branch, which would otherwise read `email-available` as an id.
   */
  if (path === '/api/customers/email-available' && method === 'GET') {
    const denied = refuse('sales:read');
    if (denied !== undefined) return denied;
    const email = (url.searchParams.get('email') ?? '').trim().toLowerCase();
    const exclude = url.searchParams.get('exclude') ?? '';
    return json({
      taken: email !== '' && CUSTOMERS.some((row) => row.id !== exclude && row.email.toLowerCase() === email),
    });
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
 * asserting on. The fields that must be present, one format, and the uniqueness checks
 * no client can perform. Codes rather than sentences, because the screen resolves them.
 *
 * The contact rules are addressed by path, such as `contacts.1.email`, because that is
 * the shape the real server answers with and the shape the form resolves. `duplicate` is
 * the one worth reproducing, because it is about the set of rows and therefore the rule
 * that proves a 422 against a repeating row lands under the right row.
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
