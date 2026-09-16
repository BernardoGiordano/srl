/**
 * Live project analysis. What is current, what is stale, what runs next, and where it
 * runs.
 *
 * It owns the lifetime of every open document, the set of documents whose answers are
 * stale, which documents a change makes stale, when the project model is re-read, when
 * the template checker's cached compiler stops being about this project's
 * configuration, and the thread a check executes on.
 *
 * As two timers and a most-recent-URI in the protocol adapter, dispatching a message
 * would mean knowing about scheduling. A second file opened within the debounce window
 * would replace the first one's pending validation, and the first would never get
 * diagnostics at all. Ordering is not a protocol concern, and freshness is not a
 * per-message decision. ADR-0090.
 *
 * Execution lives here for the same reason. A check is one synchronous compiler call,
 * so the only bound a protocol thread has is a time budget, and a check the budget
 * cancels is retried without one. Freshness and execution are one decision, because
 * the reason to stop a check is that its answer stopped being wanted. ADR-0090.
 *
 * It does not expose the lane. Callers ask for the current outcome of an editor
 * document, and whether that costs a thread, a restart or nothing is this module's to
 * decide.
 */

import { setImmediate as yieldToRequests } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { invalidateCompiler } from '../checks/template-check.mjs';

/** @import { SrlLanguageService } from './service.mjs' */

/** A configuration edit changes what the compiler was built from, not just its input. */
const CONFIGURATION = /(?:^|\/)(?:tsconfig|package)\.json$/u;

/** Files the project model reads. */
const MODELLED = /\.(?:m?js|json|html)$/u;

/** The module the validation thread runs. */
const LANE = new URL('./validation.mjs', import.meta.url);

export class LiveAnalysis {
  /** @type {SrlLanguageService} */
  #service;
  /** @type {(uri: string, diagnostics: unknown[]) => void} */
  #publish;
  /** @type {(message: string) => void} */
  #report;
  #debounce;
  /** @type {URL | string} */
  #lane;

  /** Documents whose published diagnostics are stale. @type {Set<string>} */
  #stale = new Set();
  /** @type {NodeJS.Timeout | undefined} */
  #timer;
  /** @type {NodeJS.Timeout | undefined} */
  #reloadTimer;
  #reloadConfiguration = false;
  /** @type {Promise<void>} */
  #running = Promise.resolve();
  #draining = false;
  #disposed = false;

  /** @type {Worker | undefined} */
  #worker;
  /** The highest check id no longer wanted, read by the lane while it typechecks. */
  #abandoned = new Int32Array(new SharedArrayBuffer(4));
  #nextCheck = 0;
  /**
   * Checks the lane has not answered.
   *
   * @type {Map<number, { settle: (diagnostics: unknown[] | undefined) => void, fail: (cause: Error) => void }>}
   */
  #waiting = new Map();
  /** @type {{ id: number, uri: string } | undefined} */
  #inFlight;

  /**
   * @param {{
   *   service: SrlLanguageService,
   *   publish: (uri: string, diagnostics: unknown[]) => void,
   *   report?: (message: string) => void,
   *   debounce?: number,
   *   lane?: URL | string,
   * }} options
   *   `lane` is the module the validation thread runs. Production has one; a test that
   *   needs a check to be slow on purpose supplies its own rather than making the real
   *   checker slow.
   */
  constructor(options) {
    this.#service = options.service;
    this.#publish = options.publish;
    this.#report = options.report ?? (() => {});
    this.#debounce = options.debounce ?? 120;
    this.#lane = options.lane ?? LANE;
  }

  /**
   * Read the project for the first time.
   *
   * Failure is reported rather than thrown. A project the model cannot read is a
   * project with no completions, which is worse than a server that starts and better
   * than one that does not.
   */
  async start() {
    try {
      await this.#service.reload();
    } catch (cause) {
      this.#report(`srl language server could not read this project: ${message(cause)}`);
    }
    this.#markAll();
  }

  /** @param {string} uri @param {string} languageId @param {number} version @param {string} text */
  open(uri, languageId, version, text) {
    this.#service.open(uri, languageId, version, text);
    this.#worker?.postMessage({ kind: 'open', uri, languageId, version, text });
    this.#mark(uri);
  }

  /** @param {string} uri @param {number} version @param {string} text */
  change(uri, version, text) {
    this.#service.change(uri, version, text);
    this.#worker?.postMessage({ kind: 'change', uri, version, text });
    this.#mark(uri);
  }

  /** @param {string} uri @param {string} [text] */
  save(uri, text) {
    if (text !== undefined) {
      const version = this.#service.version(uri) ?? 0;
      this.#service.change(uri, version, text);
      this.#worker?.postMessage({ kind: 'change', uri, version, text });
    }
    if (MODELLED.test(uri)) this.#scheduleReload(CONFIGURATION.test(uri));
    else this.#mark(uri);
  }

  /**
   * A closed document is one overlay fewer, which changes what its dependents typecheck
   * against, so the dependents are collected before the buffer is gone.
   *
   * @param {string} uri
   */
  close(uri) {
    const affected = this.#dependents(uri).filter((candidate) => candidate !== uri);
    this.#service.close(uri);
    this.#worker?.postMessage({ kind: 'close', uri });
    this.#stale.delete(uri);
    this.#publish(uri, []);
    for (const candidate of affected) this.#stale.add(candidate);
    // Its own check has nothing left to answer about, and the answer would arrive after
    // the empty list this method just published.
    if (this.#inFlight?.uri === uri) this.#abandon(this.#inFlight.id);
    this.#abandonSuperseded();
    if (affected.length > 0) this.#schedule();
  }

  /** @param {Array<{ uri: string }>} changes Files the editor reports changed on disk. */
  watched(changes) {
    this.#scheduleReload(changes.some((change) => CONFIGURATION.test(change.uri)));
  }

  /**
   * Finish every pending reload and check, without waiting out the debounce.
   *
   * A test asserting what the editor ends up seeing needs the queue drained, not a sleep
   * long enough to hope it was. A reload marks every document stale and a superseded
   * check queues itself again, so this runs until nothing is left rather than once.
   */
  async settle() {
    for (;;) {
      if (this.#disposed) return;
      if (this.#reloadTimer !== undefined) {
        clearTimeout(this.#reloadTimer);
        this.#reloadTimer = undefined;
        this.#queue(() => this.#reload());
      }
      if (this.#timer !== undefined) {
        clearTimeout(this.#timer);
        this.#timer = undefined;
      }
      if (this.#stale.size > 0) this.#queue(() => this.#drain());
      await this.#running;
      if (this.#stale.size === 0 && this.#timer === undefined && this.#reloadTimer === undefined) {
        return;
      }
    }
  }

  /**
   * Stop analysing, and leave no thread behind.
   *
   * Nothing is published afterwards, because a client that asked the server to shut
   * down is not expecting one more diagnostic on the way out. This resolves once the
   * lane has exited, so a caller shutting the server down knows the compiler thread it
   * started is gone rather than hoping so.
   */
  async dispose() {
    this.#disposed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    if (this.#reloadTimer !== undefined) clearTimeout(this.#reloadTimer);
    this.#timer = undefined;
    this.#reloadTimer = undefined;
    this.#stale.clear();
    await this.#stopLane();
  }

  /**
   * The thread checks run on, started on first use and replayed onto.
   *
   * A new lane has no overlays, so every open buffer is sent again. This is both the
   * first start and the one after a configuration change, and neither may answer about
   * files on disk while the editor holds unsaved edits to them.
   */
  #startLane() {
    const existing = this.#worker;
    if (existing !== undefined) return existing;
    const worker = new Worker(this.#lane, {
      workerData: { cancellation: this.#abandoned.buffer },
    });
    worker.on('message', (answer) => this.#receive(answer));
    worker.on('error', (cause) => {
      if (this.#worker === worker) this.#loseLane(worker, asError(cause));
    });
    worker.on('exit', () => {
      if (this.#worker === worker) {
        this.#loseLane(worker, new Error('the srl validation thread exited'));
      }
    });
    this.#worker = worker;
    for (const [uri, document] of this.#service.documents) {
      worker.postMessage({
        kind: 'open',
        uri,
        languageId: document.languageId,
        version: document.version,
        text: document.text,
      });
    }
    return worker;
  }

  /**
   * A lane that died takes its unanswered checks with it. They fail rather than resolving
   * empty: an empty diagnostic list reads as "no errors here", which is the one thing a
   * crashed checker has not established. The next check starts a new lane.
   *
   * @param {Worker} worker @param {Error} cause
   */
  #loseLane(worker, cause) {
    this.#worker = undefined;
    for (const check of this.#waiting.values()) check.fail(cause);
    this.#waiting.clear();
    void worker.terminate();
  }

  /** Stop the lane, treating its unanswered checks as abandoned rather than failed. */
  async #stopLane() {
    const worker = this.#worker;
    this.#worker = undefined;
    this.#abandon(this.#nextCheck);
    for (const check of this.#waiting.values()) check.settle(undefined);
    this.#waiting.clear();
    if (worker !== undefined) await worker.terminate();
  }

  /** @param {any} answer */
  #receive(answer) {
    if (typeof answer?.report === 'string') {
      this.#report(answer.report);
      return;
    }
    const check = this.#waiting.get(answer?.id);
    if (check === undefined) return;
    this.#waiting.delete(answer.id);
    if (typeof answer.error === 'string') check.fail(new Error(answer.error));
    else if (answer.cancelled === true) check.settle(undefined);
    else check.settle(answer.diagnostics);
  }

  /**
   * Diagnostics for one document from the lane, or `undefined` when they were abandoned.
   *
   * @param {string} uri @returns {Promise<unknown[] | undefined>}
   */
  #check(uri) {
    const worker = this.#startLane();
    this.#nextCheck += 1;
    const id = this.#nextCheck;
    this.#inFlight = { id, uri };
    return new Promise((settle, fail) => {
      this.#waiting.set(id, { settle, fail });
      worker.postMessage({ kind: 'check', id, uri });
    }).finally(() => {
      if (this.#inFlight?.id === id) this.#inFlight = undefined;
    });
  }

  /** @param {number} id Abandon every check up to and including `id`. */
  #abandon(id) {
    if (Atomics.load(this.#abandoned, 0) >= id) return;
    Atomics.store(this.#abandoned, 0, id);
    // A lane between compiler calls may be parked on this word rather than polling it.
    Atomics.notify(this.#abandoned, 0);
  }

  /**
   * Abandon the running check when its own document went stale under it.
   *
   * This is what replaces the time budget. A check stops because the text it is about has
   * been replaced, not because a clock ran out, so no document keeps losing its answer to
   * a deadline. ADR-0090.
   */
  #abandonSuperseded() {
    const flight = this.#inFlight;
    if (flight !== undefined && this.#stale.has(flight.uri)) this.#abandon(flight.id);
  }

  /**
   * Run `step` after whatever is already running.
   *
   * One chain, and a failed step does not break it. An analysis that stops scheduling
   * after one bad file looks to the editor exactly like a server that died.
   *
   * @param {() => Promise<void>} step
   */
  #queue(step) {
    this.#running = this.#running.then(step, step).catch((cause) => {
      this.#report(`srl analysis failed: ${message(cause)}`);
    });
  }

  /** @param {string} uri */
  #mark(uri) {
    for (const candidate of this.#dependents(uri)) {
      // Moved to the end, which is where the queue starts. The document just touched
      // is the one whose answer someone is waiting for, and a dependent of it is the
      // next most likely to be looked at.
      this.#stale.delete(candidate);
      this.#stale.add(candidate);
    }
    this.#abandonSuperseded();
    this.#schedule();
  }

  #markAll() {
    for (const uri of this.#service.documents.keys()) this.#stale.add(uri);
    this.#abandonSuperseded();
    this.#schedule();
  }

  /** @param {string} uri */
  #dependents(uri) {
    try {
      return this.#service.dependents(fromUri(uri));
    } catch {
      // A URI the model cannot place is still a document the editor is showing.
      return [uri];
    }
  }

  #schedule() {
    if (this.#disposed || this.#stale.size === 0 || this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#queue(() => this.#drain());
    }, this.#debounce);
  }

  /** @param {boolean} configuration */
  #scheduleReload(configuration) {
    if (this.#disposed) return;
    this.#reloadConfiguration = this.#reloadConfiguration || configuration;
    if (this.#reloadTimer !== undefined) clearTimeout(this.#reloadTimer);
    this.#reloadTimer = setTimeout(() => {
      this.#reloadTimer = undefined;
      this.#queue(() => this.#reload());
    }, this.#debounce);
  }

  async #reload() {
    // The compiler caches the parsed tsconfig.json, so a project whose configuration
    // changed is not the project it was built for, on either thread. Source edits keep
    // it, because discarding it costs the cold rebuild ADR-0039 exists to avoid.
    const configuration = this.#reloadConfiguration;
    this.#reloadConfiguration = false;
    if (configuration) {
      invalidateCompiler();
      await this.#stopLane();
    }
    try {
      await this.#service.reload();
    } catch (cause) {
      this.#report(`srl project refresh failed: ${message(cause)}`);
      return;
    }
    this.#worker?.postMessage({ kind: 'reload' });
    this.#markAll();
  }

  /**
   * Publish diagnostics for every stale document, most recently touched first.
   *
   * The thread is handed back before each document so that a completion which arrived
   * while the previous one was checked is answered before the next check starts. A
   * document edited while its own check ran is queued again by the edit itself, and the
   * abandoned answer is dropped, because it describes text the editor has already
   * replaced.
   */
  async #drain() {
    if (this.#draining || this.#disposed) return;
    this.#draining = true;
    try {
      while (this.#stale.size > 0 && !this.#disposed) {
        const uri = latest(this.#stale);
        if (uri === undefined) return;
        this.#stale.delete(uri);
        await yieldToRequests();
        if (!this.#service.documents.has(uri)) continue;

        const version = this.#service.version(uri);
        let diagnostics;
        try {
          diagnostics = await this.#check(uri);
        } catch (cause) {
          this.#report(`srl diagnostics failed for ${uri}: ${message(cause)}`);
          continue;
        }
        if (diagnostics === undefined) continue;
        if (this.#service.version(uri) !== version) {
          this.#stale.add(uri);
          continue;
        }
        if (!this.#disposed) this.#publish(uri, diagnostics);
      }
    } finally {
      this.#draining = false;
    }
  }
}

/** @param {Set<string>} set @returns {string | undefined} The most recently added member. */
function latest(set) {
  /** @type {string | undefined} */
  let value;
  for (const candidate of set) value = candidate;
  return value;
}

/** @param {unknown} cause */
function message(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}

/** @param {unknown} cause @returns {Error} */
function asError(cause) {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/** @param {string} uri */
function fromUri(uri) {
  return fileURLToPath(uri);
}
