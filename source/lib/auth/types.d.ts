/**
 * A session, and the store that authorizes requests for it. ADR-0021.
 *
 * No endpoint response shape appears here. The library does not know what an
 * authorization server calls its fields, and the store — which the application
 * owns — is where that knowledge belongs.
 */

export interface Session {
  readonly subject: string;
  readonly name: string;
  readonly scopes: readonly string[];
  /** Epoch milliseconds at which the access token stops being usable. */
  readonly expiresAt: number;
}

/**
 * The seam that lets the token storage decision stay open.
 *
 * A store never hands out a raw token. It authorizes a request. That single
 * choice is what allows the BFF implementation (where JS genuinely cannot see
 * the token) and the DPoP implementation (where the proof is bound to the
 * specific method and URL) to satisfy the same interface as the in-memory one.
 * An interface shaped as `getToken(): string` would have forced every caller to
 * assume bearer semantics and made BFF impossible to retrofit.
 */
export interface TokenStore {
  /**
   * A label for the strategy this store implements, for diagnostics and for a
   * screen that wants to say which one is active. Free-form on purpose: the
   * library does not hold a list of the strategies that exist.
   */
  readonly strategy: string;
  /** Restore any persisted session. Called once at startup. */
  init(): Promise<Session | null>;
  /**
   * Exchange credentials for a session.
   *
   * `unknown` rather than `{ username, password }`, because a password pair is
   * one authentication method among several and the library has no reason to
   * privilege it: a one-time code, a magic-link token and an authorization code
   * returned from a redirect are all "whatever the screen collected". The store
   * knows what it needs and refuses anything else, which is where that knowledge
   * belongs and is a check rather than an assumption.
   */
  login(credentials: unknown): Promise<Session>;
  /** Discard local session state and revoke server-side if possible. */
  logout(): Promise<void>;
  /** Refresh before expiry. Resolves null when the session cannot continue. */
  refresh(): Promise<Session | null>;
  /**
   * Attach whatever this strategy needs to authorize the request: an
   * Authorization header, a DPoP proof, or nothing at all when the browser
   * sends an HttpOnly cookie the strategy cannot touch.
   */
  authorize(request: Request): Promise<Request>;
}
