/**
 * What an application's messages are, in one declaration.
 *
 * The model is a value. A check turns it into diagnostics, an editor turns one file's
 * references into underlines, and an extraction turns the unanswered ones into catalog
 * entries. None of the three interprets a catalog itself. ADR-0117.
 */

import type { Application, MessageReference as SourceReference } from '../project-model/types.js';

/** One `t()` or `standardText()` call, and where it is written. */
export interface MessageReference extends SourceReference {
  /** Absolute path of the file that names the message. */
  file: string;
  /** Which authored form it was read from. */
  form: 'javascript' | 'template';
}

/** One locale file, flattened the way the runtime flattens it. */
export interface MessageCatalog {
  path: string;
  locale: string;
  /** The file as it stands, which is what an insertion edits. */
  text: string;
  /** Dotted key -> the message and where it is declared. */
  keys: Map<string, { value: string; line: number; column: number }>;
  /** Dotted path of every object in the file -> where it closes and how many entries it holds. */
  objects: Map<string, { end: number; entries: number }>;
}

/**
 * One registered bundle, either the application's own or a remote's.
 *
 * `scope` is the directory whose sources this bundle answers for, and null means every
 * source. A remote's bundle answers for the remote, and the application's answers for
 * everything, because the shell's translations are in the table before any remote
 * loads.
 */
export interface MessageBundle {
  name: string;
  /** The URL pattern the manifest registers, `{locale}` included. */
  pattern: string;
  scope: string | null;
  /** Every locale the application declares, whether or not this bundle ships a file for it. */
  supportedLocales: string[];
  dir: string;
  defaultPath: string;
  defaultLocale: string;
  /** Locale -> its file. A locale the bundle does not ship is absent. */
  locales: Map<string, MessageCatalog>;
}

/** Every message fact about one application. */
export interface MessageModel {
  app: Application;
  bundles: MessageBundle[];
  /** Every reference, sorted by file and line. */
  references: MessageReference[];
  /** Every dotted string the sources write outside a call, and every computed family. */
  literals: Set<string>;
}
