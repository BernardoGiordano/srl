import { AuthRejected, asRecord, failureFor, readPayload, requireString, unreachable } from '@auth/session-policy.js';

import { readTokenResponse } from './memory-store.js';

/** @import { Session, TokenStore } from '@auth/types.js' */

/**
 * DPoP: sender-constrained tokens, RFC 9449.
 *
 * THIS FILE IS APPLICATION CODE, DELIBERATELY
 *
 * The endpoint, the `grant_type` bodies and the OAuth field names below are a
 * contract with *this* application's authorization server. The library supplies
 * the `TokenStore` seam, the two error types and `sessionFrom()`, and asserts
 * nothing about the wire.
 *
 * READ THIS BEFORE CHOOSING THIS STRATEGY
 *
 * The private key is `extractable: false` and lives as a live `CryptoKey` in
 * IndexedDB, so an attacker with script execution on this origin cannot steal it.
 * They do not need to: they can call `crypto.subtle.sign()` with the same key
 * handle and have the browser mint proofs for them. "Non-extractable" is not the
 * same claim as "XSS-safe", and no configuration of this file changes that.
 * ADR-0025.
 *
 * Use this to defeat token theft — a captured token is useless without the key,
 * proofs are bound to one method and URI, and exfiltration off-origin is
 * impossible — alongside a strict CSP, Subresource Integrity and Trusted Types.
 * If XSS is the threat you actually need to close, use the BFF strategy instead.
 *
 * @implements {TokenStore}
 */
export class DpopTokenStore {
  strategy = /** @type {'dpop'} */ ('dpop');

  /** @type {string | null} */
  #accessToken = null;

  /** @type {CryptoKeyPair | null} */
  #keyPair = null;

  /** @type {JsonWebKey | null} */
  #publicJwk = null;

  #tokenEndpoint;

  /** @param {string} tokenEndpoint */
  constructor(tokenEndpoint) {
    this.#tokenEndpoint = tokenEndpoint;
  }

  /** @returns {Promise<Session | null>} */
  async init() {
    await this.#ensureKeyPair();
    return this.#exchange({ grant_type: 'refresh_token' }, true);
  }

  /**
   * @param {unknown} credentials
   * @returns {Promise<Session>}
   */
  async login(credentials) {
    const where = `The token endpoint ${this.#tokenEndpoint}`;
    const given = asRecord(credentials, `${where}: credentials`);
    await this.#ensureKeyPair();
    const session = await this.#exchange(
      {
        grant_type: 'password',
        username: requireString(given.username, `${where}: credentials.username`),
        password: requireString(given.password, `${where}: credentials.password`),
      },
      false,
    );
    if (session === null) throw new Error('Login failed.');
    return session;
  }

  async logout() {
    this.#accessToken = null;
    await fetch(this.#tokenEndpoint, { method: 'DELETE', credentials: 'same-origin' }).catch(
      () => undefined,
    );
    // Rotate the key so the next session is not bound to a key that any script
    // running during the previous one may have had a handle to.
    await deleteKeyPair();
    this.#keyPair = null;
    this.#publicJwk = null;
  }

  /** @returns {Promise<Session | null>} */
  async refresh() {
    await this.#ensureKeyPair();
    return this.#exchange({ grant_type: 'refresh_token' }, true);
  }

  /**
   * @param {Request} request
   * @returns {Promise<Request>}
   */
  async authorize(request) {
    if (this.#accessToken === null) return request;

    const authorized = new Request(request);
    authorized.headers.set('Authorization', `DPoP ${this.#accessToken}`);
    authorized.headers.set(
      'DPoP',
      await this.#createProof(request.method, request.url, this.#accessToken),
    );
    return authorized;
  }

  /**
   * Build a DPoP proof JWT for exactly one method and URI.
   *
   * @param {string} method
   * @param {string} url
   * @param {string | null} accessToken
   * @returns {Promise<string>}
   */
  async #createProof(method, url, accessToken) {
    const keyPair = await this.#ensureKeyPair();

    const header = {
      typ: 'dpop+jwt',
      alg: 'ES256',
      jwk: this.#publicJwk,
    };

    // RFC 9449 section 4.2: htu is the target URI with query and fragment
    // removed. Leaving the query in makes every proof single-use against a
    // specific query string, which breaks on any paginated endpoint.
    const target = new URL(url);
    target.search = '';
    target.hash = '';

    /** @type {Record<string, unknown>} */
    const payload = {
      jti: crypto.randomUUID(),
      htm: method.toUpperCase(),
      htu: target.toString(),
      iat: Math.floor(Date.now() / 1000),
    };

    // `ath` binds the proof to this specific access token, so a proof captured
    // alongside one token cannot be paired with another.
    if (accessToken !== null) {
      const digest = await crypto.subtle.digest('SHA-256', encode(accessToken));
      payload.ath = base64url(digest);
    }

    const signingInput = `${base64url(encode(JSON.stringify(header)))}.${base64url(
      encode(JSON.stringify(payload)),
    )}`;

    // ECDSA over SHA-256. WebCrypto returns the raw r||s concatenation, which is
    // precisely the form JOSE specifies for ES256, so no DER unwrapping is needed.
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      keyPair.privateKey,
      encode(signingInput),
    );

    return `${signingInput}.${base64url(signature)}`;
  }

  /** @returns {Promise<CryptoKeyPair>} */
  async #ensureKeyPair() {
    if (this.#keyPair !== null) return this.#keyPair;

    let keyPair = await loadKeyPair();
    if (keyPair === null) {
      keyPair = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        // extractable: false. The private key can sign and can be structured-
        // cloned into IndexedDB, but exportKey() on it rejects, so it can never
        // become bytes that leave the browser.
        false,
        ['sign', 'verify'],
      );
      await saveKeyPair(keyPair);
    }

    this.#keyPair = keyPair;
    // The public half is always extractable, regardless of the flag above, which
    // is what lets us publish it in the proof header.
    const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
    this.#publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
    return keyPair;
  }

  /**
   * @param {Record<string, string>} body
   * @param {boolean} allowUnauthenticated
   * @returns {Promise<Session | null>}
   */
  async #exchange(body, allowUnauthenticated) {
    const request = new Request(this.#tokenEndpoint, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    // The token request itself carries a proof, with no `ath` because there is no
    // access token yet. This is how the authorization server learns the key to
    // bind the issued token to.
    //
    // `request.url` rather than the configured endpoint: manifest admission
    // normalizes every destination to a root-relative path, and RFC 9449's `htu`
    // is an absolute URI. Reading it back off the Request resolves it against the
    // document exactly once, and against the same base the fetch below uses, so
    // the proof cannot be bound to a URL other than the one it travels to.
    request.headers.set('DPoP', await this.#createProof('POST', request.url, null));

    const where = `The token endpoint ${this.#tokenEndpoint}`;

    let response;
    try {
      response = await fetch(request);
    } catch (cause) {
      throw unreachable(where, cause);
    }

    if (response.status === 401 || response.status === 403) {
      this.#accessToken = null;
      if (allowUnauthenticated) return null;
      throw new AuthRejected(`${where} rejected the credentials.`);
    }
    if (!response.ok) {
      this.#accessToken = null;
      throw await failureFor(response, where);
    }

    // Cleared before admission, assigned after it, for the reason
    // memory-store.js gives: a token kept through a failed admission would go on
    // authorizing requests for a session the client has already ended.
    this.#accessToken = null;
    const admitted = readTokenResponse(await readPayload(response, where), where);
    this.#accessToken = admitted.accessToken;
    return admitted.session;
  }
}

/* ── IndexedDB, kept to the minimum this needs ─────────────────────────── */

const DB_NAME = 'auth-dpop';
const STORE_NAME = 'keys';
const KEY_ID = 'current';

/** @returns {Promise<IDBDatabase>} */
function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexedDB.open failed'));
  });
}

/**
 * Resolves `unknown` rather than a generic, deliberately. `IDBRequest.result` is
 * `any`, and letting a generic launder it would hand callers a confidently typed
 * value that nothing checked. `loadKeyPair` narrows it explicitly instead.
 *
 * @param {IDBTransactionMode} mode
 * @param {(store: IDBObjectStore) => IDBRequest} run
 * @returns {Promise<unknown>}
 */
async function withStore(mode, run) {
  const db = await openDb();
  try {
    // Annotated explicitly. Without it TypeScript infers the Promise's type
    // argument from the `resolve` call, and `IDBRequest.result` is `any`, so the
    // whole thing would come back as `Promise<any>` and quietly undo the point of
    // returning `unknown`.
    /** @type {Promise<unknown>} */
    const settled = new Promise((resolve, reject) => {
      const request = run(db.transaction(STORE_NAME, mode).objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    });
    return await settled;
  } finally {
    db.close();
  }
}

/** @returns {Promise<CryptoKeyPair | null>} */
async function loadKeyPair() {
  const stored = await withStore('readonly', (store) => store.get(KEY_ID));
  if (typeof stored !== 'object' || stored === null) return null;

  const candidate = /** @type {Partial<CryptoKeyPair>} */ (stored);
  if (
    !(candidate.privateKey instanceof CryptoKey) ||
    !(candidate.publicKey instanceof CryptoKey)
  ) {
    await deleteKeyPair();
    return null;
  }

  // Structured clone round-trips a CryptoKey with its internal slots intact, so
  // what comes back out is still non-extractable. Verify rather than assume: a key
  // that reads back as extractable means something rewrote this record, and it
  // must not be trusted for signing.
  if (candidate.privateKey.extractable) {
    await deleteKeyPair();
    return null;
  }

  return { privateKey: candidate.privateKey, publicKey: candidate.publicKey };
}

/** @param {CryptoKeyPair} keyPair */
async function saveKeyPair(keyPair) {
  await withStore('readwrite', (store) => store.put(keyPair, KEY_ID));
}

async function deleteKeyPair() {
  await withStore('readwrite', (store) => store.delete(KEY_ID)).catch(() => undefined);
}

/* ── Encoding ──────────────────────────────────────────────────────────── */

const textEncoder = new TextEncoder();

/**
 * `TextEncoder.encode` is typed as `Uint8Array<ArrayBufferLike>`, and WebCrypto
 * wants `BufferSource`, which excludes `SharedArrayBuffer`-backed views. The
 * encoder never returns one, so narrowing here is sound and keeps the assertion
 * in a single place rather than at every crypto call site.
 *
 * @param {string} value
 * @returns {Uint8Array<ArrayBuffer>}
 */
function encode(value) {
  return /** @type {Uint8Array<ArrayBuffer>} */ (textEncoder.encode(value));
}

/**
 * @param {ArrayBuffer | Uint8Array} bytes
 * @returns {string}
 */
function base64url(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}
