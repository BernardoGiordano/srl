/**
 * What "serve one srl application" is, in one declaration.
 *
 * Four servers in this repository answered that question separately — the
 * development server, the benchmark origin, the artifact test origin and the test
 * runner's mount middleware — and the parts they had in common were copied rather
 * than shared: the same `toFilePath`, the same traversal refusal, the same
 * directory index, the same history fallback, drifting one commit at a time.
 *
 * `cli/origin/index.mjs` owns those rules. What is left for a caller to state is
 * the part that genuinely differs, and it is the four fields of `OriginOptions`.
 * ADR-0075.
 */

import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Stats } from 'node:fs';

/**
 * URL prefix -> where it resolves. A file mount's target is an absolute
 * directory; the test runner's is another URL prefix, which is why this is a pair
 * of strings and not a pair of directories.
 *
 * Order is the caller's and it matters: resolution takes the first prefix that
 * matches, so a mount nested inside another must be declared before it, and `/`
 * — which matches everything — must be declared last.
 */
export type Mount = readonly [string, string];

/** Which mount claimed a path, and what was left of the path after the prefix. */
export interface MountMatch {
  prefix: string;
  target: string;
  /** Relative, with no leading slash: `core/reactive.js` for `/lib/core/reactive.js`. */
  rest: string;
}

/** What a transform is told about the request it may answer differently. */
export interface TransformContext {
  /** The requested path, not the resolved file: a history fallback has these disagree. */
  pathname: string;
  request: IncomingMessage;
  /** The resolved file's stats, already read. */
  stats: Stats;
}

/**
 * A body to send instead of the file on disk, plus whatever headers describe it
 * being different — `Content-Encoding: gzip` for the benchmark, nothing at all
 * for an injected script tag. `Content-Length` is the origin's to set.
 *
 * A transformed body carries no `ETag` unless one is stated here. The origin's own
 * validator is built from the file's size and mtime, and those describe the file
 * rather than what a transform made of it: a body that also depends on the
 * adapter's configuration would be revalidated against something that
 * configuration does not change. A transform that knows its bytes are a pure
 * function of the file it was handed may say so by setting `ETag` itself.
 */
export interface Representation {
  body: Buffer;
  headers?: Record<string, string>;
}

/** What one origin serves, and the four ways an adapter differs from another. */
export interface OriginOptions {
  mounts: ReadonlyArray<Mount>;
  /**
   * The document a navigation to a path with no file gets: an application's
   * `index.html`, absolute. Null serves 404 instead, which is what a mount table
   * with no application under it wants.
   */
  fallback?: string | null;
  /**
   * Extra response headers for a static hit — a cache policy, a
   * Content-Security-Policy on the entry document. `Cache-Control: no-store` and
   * the file's own `Content-Type` are the defaults this replaces.
   *
   * This is where a 304 is bought. The origin already sends an `ETag` for a
   * streamed file and already answers `If-None-Match`; a policy of `no-store`
   * means no browser ever sends one, and `no-cache` means every reload does.
   */
  headers?: (pathname: string, file: string) => Record<string, string>;
  /**
   * A body to send in place of the file's own bytes, or null to stream the file.
   * The live-reload injection, the benchmark's gzip, the artifact suite's
   * deliberately tampered byte and its rewritten entry document are all this.
   */
  transform?: (
    file: string,
    context: TransformContext,
  ) => Promise<Representation | null> | Representation | null;
  /**
   * An adapter's own routes, consulted before anything static — before the method
   * check and before the mounts, because both are rules about files.
   *
   * `true` means the request was answered here. This is where the development
   * server's proxy and live-reload stream live, where the benchmark's harness page
   * and backend live, and where the artifact suite's injected modules live. It is
   * deliberately the only extension point of that kind: ADR-0069's proxy must stay
   * one adapter's concern rather than an option every origin carries.
   */
  route?: (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean> | boolean;
}

/** The origin as a request handler, for a caller that owns its own server. */
export interface Origin {
  handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
}

/** How `serveOrigin` binds. */
export interface ListenOptions {
  /** 0, the default, is an ephemeral port: what every test and the benchmark want. */
  port?: number;
  /** Null binds every interface, which is what a development server wants. */
  host?: string | null;
  /**
   * Called when a request handler throws. Return a body to send with the 500, or
   * nothing for the default — a benchmark wants the cause in the response, a
   * development server wants it on its own stdout.
   */
  failed?: (cause: unknown, request: IncomingMessage) => string | void;
}

/** A bound origin. */
export interface RunningOrigin {
  url: string;
  port: number;
  server: Server;
  close: () => Promise<void>;
}
