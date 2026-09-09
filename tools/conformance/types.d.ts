/**
 * The editor conformance contract: what a scenario asks, and what an adapter answers
 * for one installed editor. ADR-0097.
 */

/** The projects the fixture builds. */
export type RootName = 'one' | 'two' | 'declared' | 'plain';

/** Where a request is made in a document. */
export type Anchor = { after: string } | { on: string };

/** What an answer has to contain. */
export interface Expectation {
  /** Roots that must each have exactly one language server. */
  serving?: RootName[];
  /** Roots that must have none. */
  silent?: RootName[];
  /** The document must publish no srl diagnostics. */
  empty?: boolean;
  /** Substrings, each of which must appear in the answer. */
  includes?: string[];
  /** Substrings, none of which may appear. */
  excludes?: string[];
  /** A root-relative path the answer must point at. */
  file?: string;
  /** Root-relative paths the answer must edit, and no others. */
  files?: string[];
}

/** One thing an installed editor has to do. */
export interface Scenario {
  id: string;
  title: string;
  kind: 'language' | 'session';
  ask:
    | 'servers'
    | 'restart'
    | 'orphans'
    | 'diagnostics'
    | 'completion'
    | 'hover'
    | 'definition'
    | 'rename'
    | 'watch'
    | 'trace';
  /** Root-relative, in `root` or in `one`. */
  document?: string;
  root?: RootName;
  at?: Anchor;
  /** An unsaved buffer edit made before the request. */
  edit?: { replace: string; with: string };
  /** A change written to disk, outside the editor, before the request. */
  write?: { document: string; replace: string; with: string };
  /** Documents to open first, for their effect on the session rather than their answers. */
  open?: Array<{ root: RootName; document: string }>;
  /** Roots to add to the window before asking. */
  add?: RootName[];
  /** Restarts to perform. */
  times?: number;
  /** The new name, for a rename. */
  to?: string;
  expect: Expectation;
}

/** What one scenario did in one editor. */
export interface ScenarioResult {
  id: string;
  status: 'pass' | 'fail' | 'unavailable';
  /** Why it failed, or why the editor cannot answer it. */
  detail: string;
}

/** One installed editor, at one version. */
export interface AdapterRun {
  /** `vscode`, `webstorm`. */
  adapter: string;
  /** `minimum` or `current`. */
  edition: string;
  /** The version actually installed, or the reason none was. */
  version: string;
  results: ScenarioResult[];
}

/** The projects a run is driven against. */
export interface Fixture {
  root: string;
  roots: Record<RootName, string>;
}

/** An installed editor this run can drive. */
export interface Adapter {
  name: string;
  /** The scenarios this editor can be asked, by id. */
  covers: (scenario: Scenario) => boolean;
  /** Every edition of this editor, each already resolved to an installed copy or a reason. */
  drive: (fixture: Fixture, scenarios: Scenario[], options?: { editions?: string[] }) => Promise<AdapterRun[]>;
}
