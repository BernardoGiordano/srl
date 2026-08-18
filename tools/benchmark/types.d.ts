/**
 * The benchmark harness's own vocabulary.
 *
 * Node and browser halves both read these: a workload module served to Chrome
 * produces `BenchmarkSample`s, and the runner in Node turns them into
 * `WorkloadRecord`s. Keeping the shapes in one declaration file is what stops the
 * two halves from disagreeing about what a sample is — the JSON that crosses
 * between them is not type-checked at the boundary, so the declaration is the
 * only thing that can hold them together.
 */

/** Workload families, reported and filterable separately. */
export type Suite =
  | 'startup'
  | 'template'
  | 'router'
  | 'collection'
  | 'memory'
  | 'delivery'
  | 'tooling';

/** How much work a run does. `ci` is the bounded profile the gate uses. */
export type Mode = 'local' | 'ci';

/**
 * How a workload is driven.
 *
 * `browser` runs the whole sample loop inside one page, which is the cheapest and
 * least noisy option and therefore the default. `page` gets one fresh page per
 * sample, for anything that measures a load or needs a heap reading between
 * phases. `node` never opens a browser at all: tooling timings are child
 * processes.
 */
export type Driver = 'browser' | 'page' | 'node';

/** One workload, as declared in the registry. */
/**
 * What an application declares in `<app>/benchmark.json`. Read by
 * tools/benchmark/declaration.mjs; absent for every application that ships none.
 */
export interface ArtifactDeclaration {
  /** The application the declaration was read from. Filled in by the reader. */
  app: string;
  /** Path, relative to the application directory, of a module exporting `installFakeServer`. */
  backend?: string;
  /** Every route reached through a literal dynamic import, one workload each. */
  lazyRoutes: ReadonlyArray<{ id: string; path: string; tag: string }>;
  /** The route kept unopened until after a simulated publication switch. */
  staleReleaseRoute?: { path: string; tag: string; module: string };
}

export interface WorkloadSpec {
  id: string;
  suite: Suite;
  title: string;
  driver: Driver;
  /** Samples per mode, after warmup. */
  samples: Record<Mode, number>;
  /** Discarded samples taken before measurement starts. */
  warmup: Record<Mode, number>;
  /** Metric name -> unit, for reporting. Defaults to `{ duration: 'ms' }`. */
  units?: Record<string, string>;
  /** Browser workloads: the module served to the page and the export to call. */
  browser?: { module: string; export: string; args?: Record<string, unknown> };
  /** Node workloads: what to run. Given the run context, returns its samples. */
  run?: (context: NodeWorkloadContext) => Promise<BenchmarkSample[]>;
  /** Excluded from `--ci`, for workloads too slow or too noisy to gate on. */
  localOnly?: boolean;
  /** Restrict an application-specific workload without teaching its driver dispatch. */
  apps?: readonly string[];
  /** Restrict delivery workloads to origin adapters that expose the needed behavior. */
  origins?: readonly ('source' | 'dist')[];
}

/** One measurement attempt. */
export interface BenchmarkSample {
  /** Milliseconds, for a timed workload. */
  duration?: number;
  /** Any other numbers this sample produced: bytes, requests, retained nodes. */
  metrics?: Record<string, number>;
  /** False when the workload's own correctness check failed. */
  ok: boolean;
  /** Why it failed, or a note worth keeping on a passing sample. */
  detail?: string;
}

export interface MetricStats {
  median: number;
  p95: number;
  mean: number;
  min: number;
  max: number;
}

/** One workload's result, as printed and as written to JSON. */
export interface WorkloadRecord {
  id: string;
  suite: Suite;
  title: string;
  units: Record<string, string>;
  samples: number;
  warmup: number;
  metrics: Record<string, MetricStats>;
}

/** Everything about the machine that produced a result. */
export interface Environment {
  /** Stable identity of the machine and toolchain, used to gate comparisons. */
  profile: string;
  platform: string;
  release: string;
  arch: string;
  cpu: string;
  cores: number;
  memoryGiB: number;
  node: string;
  chrome: string;
  dependencies: Record<string, string>;
}

/**
 * The two fixed reference workloads. `arithmetic` is the CPU clock and nothing else;
 * `layout` is the renderer's throughput, which is what page-side workloads are
 * actually subject to. See tools/benchmark/browser/calibration.js.
 */
export type ReferenceKind = 'arithmetic' | 'layout';

/** Median milliseconds of each reference, from one reading. */
export type ReferenceReading = Record<ReferenceKind, number>;

/** Every reference reading a run took, and what they say about the machine. */
export interface CalibrationRecord {
  /** How many readings this record summarises: one per suite, plus a closing one. */
  readings: number;
  /** Median across the run's readings. The figure a later run drifts against. */
  overall: ReferenceReading;
  /** The reading taken immediately before each suite ran. Suite name -> reading. */
  bySuite: Record<string, ReferenceReading>;
  /**
   * Largest ratio between two readings of the same reference in this run. Above
   * `maxRunSpread` the machine changed while it was being measured, and the run is
   * reported rather than gated.
   */
  spread: ReferenceReading;
}

/** A checked-in or freshly written result file. */
export interface BaselineFile {
  /** Result-file shape. See `BASELINE_VERSION` in tools/benchmark/measure.mjs. */
  version: number;
  /** ISO date. Written by the run, read by nothing that computes with it. */
  recorded: string;
  mode: Mode;
  app: string;
  environment: Environment;
  /**
   * What the fixed reference workloads measured, which is how a later run knows
   * whether this machine was faster or slower than the one that recorded this.
   */
  calibration: CalibrationRecord;
  results: WorkloadRecord[];
}

export type ComparisonStatus =
  | 'ok'
  | 'regressed'
  | 'improved'
  | 'new'
  | 'new-metric'
  | 'incomparable'
  | 'within-slack'
  | 'over-budget';

export interface Comparison {
  id: string;
  metric: string;
  unit: string;
  current: MetricStats;
  baseline: MetricStats | null;
  /** Fractional change against the baseline median: 0.2 is 20% slower. */
  change: number | null;
  status: ComparisonStatus;
  productBudget: number | null;
}

/** Regression thresholds and absolute product limits, from budgets.json. */
export interface BudgetFile {
  regressionThreshold: number;
  /** Per-suite override, for suites whose repeatability is genuinely worse. */
  suiteThresholds: Record<string, number>;
  /** Unit -> smallest absolute change that can count as a regression. */
  minDelta: Record<string, number>;
  /**
   * How far a reference workload may drift from the baseline's before a comparison is
   * called incomparable rather than merely scaled. A machine three times slower is a
   * different machine, whatever the calibration says.
   */
  maxSpeedDrift: number;
  /**
   * How far a reference workload may move *within* one run before the same applies.
   * A machine that changed between the template suite and the collection suite cannot
   * tell a regression from the load that changed it.
   */
  maxRunSpread: number;
  ciMaxSeconds: number;
  /** workload id -> metric -> absolute limit. Needs user approval to populate. */
  product: Record<string, Record<string, number>>;
}

/** What a node-driven workload is handed. */
export interface NodeWorkloadContext {
  mode: Mode;
  samples: number;
  warmup: number;
  app: { name: string; dir: string };
  repo: string;
  /** Verified production artifact facts, present only for the dist origin adapter. */
  artifact?: {
    root: string;
    report: {
      app: string;
      totals: { files: number; bytes: number; gzip: number; brotli: number };
      chunks: Array<{
        path: string;
        entry: boolean;
        dynamicEntry: boolean;
        imports: string[];
        dynamicImports: string[];
        modules: string[];
      }>;
      files: Array<{
        path: string;
        cache: string;
        bytes: number;
        gzip: number;
        brotli: number;
        sha256: string;
      }>;
    };
  };
  /** Open a page against the benchmark origin. Only for browser-backed workloads. */
  origin: BenchmarkOrigin;
  browser: BenchmarkBrowser;
}

/** The static origin under measurement. */
export interface BenchmarkOrigin {
  url: string;
  /**
   * Move selected immutable URLs out of the simulated current release while retaining
   * their bytes for pages that loaded the previous release.
   */
  switchRelease?: (replacedAssets: readonly string[]) => {
    retainedRequests(): string[];
    restore(): void;
  };
  close(): Promise<void>;
}

export interface RequestRecord {
  url: string;
  type: string;
  status: number;
  encodedBytes: number;
  fromCache: boolean;
}

/** The Chrome the harness drives, with the two capabilities workloads need. */
export interface BenchmarkBrowser {
  /** A page on the benchmark origin, with the application's own import map. */
  harnessPage(): Promise<BenchmarkPage>;
  /** A page that has navigated to a path on the benchmark origin. */
  load(path: string, options?: { cache?: boolean; init?: string }): Promise<BenchmarkPage>;
  close(): Promise<void>;
  version: string;
}

export interface BenchmarkPage {
  /** Navigate again, on the same page, so a second load can be a warm one. */
  goto(path: string): Promise<void>;
  /** Evaluate an async function's source in the page and return its JSON result. */
  evaluate<T>(body: string, argument?: unknown): Promise<T>;
  /** Collect garbage, then report the used JavaScript heap in bytes. */
  heap(): Promise<number>;
  /** Nodes and listeners the page currently retains, via the DevTools protocol. */
  retained(): Promise<{ nodes: number; listeners: number }>;
  /** Same-origin requests this page made, in order, with encoded sizes. */
  requests(): RequestRecord[];
  /** Requests that tried to leave the origin. A non-empty list fails the run. */
  offOrigin(): string[];
  /** Forget recorded traffic, so one sample's accounting is its own. */
  reset(): void;
  /** Uncaught page errors, which no workload is allowed to have produced. */
  errors(): string[];
  close(): Promise<void>;
}
