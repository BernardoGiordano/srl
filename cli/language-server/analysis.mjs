/**
 * Live project analysis: what is current, what is stale, and what runs next.
 *
 * WHAT IT OWNS
 *
 * The lifetime of every open document, the set of documents whose answers are stale,
 * which documents a change makes stale, when the project model is re-read, and when the
 * template checker's cached compiler stops being about this project's configuration.
 *
 * WHY IT EXISTS
 *
 * This was two timers and a most-recent-URI in the protocol adapter, so dispatching a
 * message meant knowing about scheduling: a second file opened within the debounce window
 * replaced the first one's pending validation, and the first never got diagnostics at
 * all. Ordering is not a protocol concern, and freshness is not a per-message decision.
 * ADR-0091.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not interrupt a typecheck. `checkTemplateSource()` is one synchronous call, so
 * the thread comes back between documents, not inside one. What bounds a single check is
 * its cancellation budget; what bounds the queue is that the work is per affected
 * template rather than per project.
 */

import { setImmediate as yieldToRequests } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { invalidateCompiler } from '../checks/template-check.mjs';

/** @import { SrlLanguageService } from './service.mjs' */

/** A configuration edit changes what the compiler was built from, not just its input. */
const CONFIGURATION = /(?:^|\/)(?:tsconfig|package)\.json$/u;

/** Files the project model reads. */
const MODELLED = /\.(?:m?js|json|html)$/u;

export class LiveAnalysis {
  /** @type {SrlLanguageService} */
  #service;
  /** @type {(uri: string, diagnostics: unknown[]) => void} */
  #publish;
  /** @type {(message: string) => void} */
  #report;
  #debounce;
  #budget;

  /** Documents whose published diagnostics are stale. @type {Set<string>} */
  #stale = new Set();
  /** Documents that already lost one check to the budget. @type {Set<string>} */
  #patient = new Set();
  /** @type {NodeJS.Timeout | undefined} */
  #timer;
  /** @type {NodeJS.Timeout | undefined} */
  #reloadTimer;
  #reloadConfiguration = false;
  /** @type {Promise<void>} */
  #running = Promise.resolve();
  #draining = false;
  #disposed = false;

  /**
   * @param {{
   *   service: SrlLanguageService,
   *   publish: (uri: string, diagnostics: unknown[]) => void,
   *   report?: (message: string) => void,
   *   debounce?: number,
   *   budget?: number,
   * }} options
   */
  constructor(options) {
    this.#service = options.service;
    this.#publish = options.publish;
    this.#report = options.report ?? (() => {});
    this.#debounce = options.debounce ?? 120;
    this.#budget = options.budget ?? 5000;
  }

  /**
   * Read the project for the first time.
   *
   * Failure is reported rather than thrown: a project the model cannot read is a project
   * with no completions, which is worse than a server that starts and better than one
   * that does not.
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
    this.#mark(uri);
  }

  /** @param {string} uri @param {number} version @param {string} text */
  change(uri, version, text) {
    this.#service.change(uri, version, text);
    this.#mark(uri);
  }

  /** @param {string} uri @param {string} [text] */
  save(uri, text) {
    if (text !== undefined) this.#service.change(uri, this.#service.version(uri) ?? 0, text);
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
    this.#stale.delete(uri);
    this.#patient.delete(uri);
    this.#publish(uri, []);
    for (const candidate of affected) this.#stale.add(candidate);
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
   * Stop analysing. Nothing is published afterwards: a client that asked the server to
   * shut down is not expecting one more diagnostic to arrive on the way out.
   */
  dispose() {
    this.#disposed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    if (this.#reloadTimer !== undefined) clearTimeout(this.#reloadTimer);
    this.#timer = undefined;
    this.#reloadTimer = undefined;
    this.#stale.clear();
  }

  /**
   * Run `step` after whatever is already running.
   *
   * One chain, and a failed step does not break it: an analysis that stops scheduling
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
      // Moved to the end, which is where the queue starts: the document just touched is
      // the one whose answer someone is waiting for, and a dependent of it is the next
      // most likely to be looked at.
      this.#stale.delete(candidate);
      this.#stale.add(candidate);
    }
    this.#schedule();
  }

  #markAll() {
    for (const uri of this.#service.documents.keys()) this.#stale.add(uri);
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
    // changed is not the project it was built for. Source edits keep it: discarding it
    // costs the cold rebuild ADR-0039 exists to avoid.
    const configuration = this.#reloadConfiguration;
    this.#reloadConfiguration = false;
    if (configuration) invalidateCompiler();
    try {
      await this.#service.reload();
    } catch (cause) {
      this.#report(`srl project refresh failed: ${message(cause)}`);
      return;
    }
    this.#markAll();
  }

  /**
   * Publish diagnostics for every stale document, most recently touched first.
   *
   * The thread is handed back before each document so that a completion which arrived
   * while the previous one was checked is answered before the next check starts. A
   * document edited while its own check ran is queued again instead of published: the
   * answer describes text the editor has already replaced.
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
        const patient = this.#patient.has(uri);
        let diagnostics;
        try {
          diagnostics = await this.#service.diagnostics(uri, {
            cancellation: patient ? undefined : deadline(this.#budget),
          });
        } catch (cause) {
          if (!(cause instanceof ts.OperationCanceledException)) {
            this.#report(`srl diagnostics failed for ${uri}: ${message(cause)}`);
            continue;
          }
          // One check may cost more than the budget protects. The retry is unbudgeted,
          // so a slow project is slow rather than silent.
          this.#patient.add(uri);
          this.#stale.add(uri);
          continue;
        }
        this.#patient.delete(uri);
        if (this.#service.version(uri) !== version) {
          this.#stale.add(uri);
          continue;
        }
        this.#publish(uri, diagnostics);
      }
    } finally {
      this.#draining = false;
    }
  }
}

/** @param {number} budget @returns {ts.CancellationToken} */
function deadline(budget) {
  const until = Date.now() + budget;
  return {
    isCancellationRequested: () => Date.now() > until,
    throwIfCancellationRequested() {
      // Not an Error, and it has to not be: the compiler recognises its own cancellation
      // by this type, and anything else travels as a template finding instead.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      if (this.isCancellationRequested()) throw new ts.OperationCanceledException();
    },
  };
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

/** @param {string} uri */
function fromUri(uri) {
  return fileURLToPath(uri);
}
