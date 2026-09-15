/**
 * Dynamic mounting. Turns "show this view here" into one mounted custom element.
 *
 * `<x-outlet>`, the router and `@core/remotes/mfe.js` each describe what to mount
 * as a `MountRequest`, and this module applies the shared rules. Each caller keeps
 * its own concerns. The outlet owns a signal, the router owns the route chain, and
 * `mfe.js` owns the revocable host context.
 *
 * - A tag that is already defined is created without calling `load`.
 * - A tag still undefined after `load` resolves is an error. `defineComponent` runs
 *   at the end of a component module, so this means that module has a bug.
 * - Overlapping mounts resolve by generation. `MountSequence` hands out one
 *   `MountAttempt` per mount, and after every await the attempt checks whether it
 *   is still the newest.
 */

import { resolveTag } from '@core/elements/component.js';

/** @import { MountRequest } from '@core/elements/types.js' */

/**
 * A mount failed. `where` names the caller, such as `<x-outlet>`, `Route "/users"`
 * or `Remote "billing"`, so a handler can group failures without parsing the
 * message.
 */
export class MountError extends Error {
  /** @type {string} */
  where;

  /**
   * @param {string} where
   * @param {string} detail
   */
  constructor(where, detail) {
    super(`${where} ${detail}`);
    this.name = 'MountError';
    this.where = where;
  }
}

/* ── Load and definition ───────────────────────────────────────────────── */

/**
 * Resolve the custom element a request names, loading its module first when the
 * element isn't defined yet.
 *
 * Returns `undefined` only when the request names no tag at all, which is legal for
 * a route level that only adds a path prefix and a guard. Every other failure
 * throws.
 *
 * When the request names no tag, the value `load` resolves to is read as a
 * component reference. A lazy route relies on this with
 * `load: () => import('./users-page.js').then((m) => m.UsersPage)`.
 *
 * @param {MountRequest} request
 * @returns {Promise<string | undefined>}
 */
export async function defineTag(request) {
  const named = readTag(request);
  if (named !== undefined && customElements.get(named) !== undefined) return named;

  if (request.load === undefined) {
    if (named === undefined) return undefined;
    throw new MountError(
      request.where,
      `names <${named}>, which is not a defined custom element and has no \`load\` function ` +
        `to define it.`,
    );
  }

  const loaded = await request.load();

  const tag = named ?? resolveTag(loaded);
  if (tag === undefined) return undefined;
  if (customElements.get(tag) === undefined) {
    throw new MountError(
      request.where,
      `names <${tag}>, still undefined after \`load\` resolved. The loaded module must define ` +
        `it while it evaluates, which is what \`await defineComponent({ tag: '${tag}', ... })\` ` +
        `at the end of a component module does.`,
    );
  }
  return tag;
}

/* ── Instantiation ─────────────────────────────────────────────────────── */

/**
 * Build the element a request names, loading it if needed, and assign its props.
 *
 * `null` means the request names nothing to mount. A request with `create` never
 * returns null. Use `requireElement` when nothing is not a valid answer.
 *
 * The element isn't inserted anywhere, because each caller places it differently.
 *
 * @param {MountRequest} request
 * @returns {Promise<HTMLElement | null>}
 */
export async function createElement(request) {
  const { create } = request;
  const element =
    create === undefined ? await fromTag(request) : await fromFactory(request, create);
  if (element === null) return null;

  // Props are assigned as properties, because attributes would stringify objects.
  Object.assign(element, request.props ?? {});
  return element;
}

/**
 * Like `createElement`, but throws when the request names nothing to mount.
 *
 * @param {MountRequest} request
 * @returns {Promise<HTMLElement>}
 */
export async function requireElement(request) {
  const element = await createElement(request);
  if (element === null) {
    throw new MountError(request.where, 'names no custom element to mount.');
  }
  return element;
}

/**
 * @param {MountRequest} request
 * @returns {Promise<HTMLElement | null>}
 */
async function fromTag(request) {
  const tag = await defineTag(request);
  if (tag === undefined) return null;
  return document.createElement(tag);
}

/**
 * Validate what a `create` factory returns. A factory runs code this module didn't
 * write, such as a route's `mount()` or a remote's `mount(host)`, so a wrong result
 * fails here with a clear message.
 *
 * @param {MountRequest} request
 * @param {NonNullable<MountRequest['create']>} create
 * @returns {Promise<HTMLElement>}
 */
async function fromFactory(request, create) {
  const created = await create();
  if (!(created instanceof HTMLElement)) {
    throw new MountError(request.where, 'mount() did not return an HTMLElement.');
  }

  const tag = readTag(request);
  if (tag === undefined) return created;

  if (created.localName !== tag) {
    throw new MountError(
      request.where,
      `names <${tag}> but its mount() returned <${created.localName}>.`,
    );
  }
  if (customElements.get(tag) === undefined) {
    throw new MountError(
      request.where,
      `names <${tag}>, which its mount() returned without defining as a custom element.`,
    );
  }
  return created;
}

/**
 * The tag a request names, whether given as a tag, a class or a definition.
 *
 * @param {MountRequest} request
 * @returns {string | undefined}
 */
function readTag(request) {
  return resolveTag(request.tag);
}

/* ── Cancellation and replacement ──────────────────────────────────────── */

/**
 * One caller's series of mounts, of which only the newest may complete.
 *
 * A slow mount that resolves after a newer one must not replace the newer view.
 * Each mount claims an attempt, and a superseded attempt discards its own work.
 *
 * The router shares one sequence between navigation and mounting, because a
 * superseded navigation and a superseded mount are the same event.
 */
export class MountSequence {
  #generation = 0;

  /**
   * Start a new attempt and supersede the running one.
   *
   * @returns {MountAttempt}
   */
  begin() {
    this.#generation += 1;
    return new MountAttempt(this, this.#generation);
  }

  /**
   * Supersede the running attempt without starting a new one. Used when a router
   * stops or an outlet disconnects.
   */
  cancel() {
    this.#generation += 1;
  }

  /**
   * @param {number} generation
   * @returns {boolean}
   */
  holds(generation) {
    return generation === this.#generation;
  }
}

/**
 * One mount. Created by `MountSequence.begin`.
 */
export class MountAttempt {
  #sequence;
  #generation;

  /**
   * @param {MountSequence} sequence
   * @param {number} generation
   */
  constructor(sequence, generation) {
    this.#sequence = sequence;
    this.#generation = generation;
  }

  /** Whether this attempt is still the newest of its sequence. */
  get live() {
    return this.#sequence.holds(this.#generation);
  }

  /**
   * Keep `element` if this attempt is still current, and release it otherwise.
   *
   * Callers use this after every await. A `create` may have acquired resources, so
   * a discarded element must still be released.
   *
   * @param {HTMLElement | null} element
   * @param {MountRequest} request
   * @returns {Promise<boolean>}
   */
  async keep(element, request) {
    if (this.live) return true;
    if (element !== null) await request.release?.(element);
    return false;
  }

  /**
   * Replace `container`'s children with `element` if this attempt is still current.
   * Otherwise release the element and return false.
   *
   * A null element places nothing, and the staleness check still applies.
   *
   * @param {HTMLElement} container
   * @param {HTMLElement | null} element
   * @param {MountRequest} request
   * @returns {Promise<boolean>}
   */
  async place(container, element, request) {
    if (!(await this.keep(element, request))) return false;
    if (element !== null) container.replaceChildren(element);
    return true;
  }
}
