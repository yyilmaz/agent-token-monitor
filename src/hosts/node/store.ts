// Standalone host: keeps the latest analysis in memory and rebuilds it when logs or configuration change (ADR 0013).
// Changes are noticed with a read-only stat of every matching file; only changed files are read again, and each file's
// parsed result is kept in memory, never its text (ADR 0014). Nothing is written anywhere (R-15).

import { stat } from "node:fs/promises";

import {
  ANTIGRAVITY_FILE_PATTERN,
  ANTIGRAVITY_INDEX_FILE_PATTERN,
  combineAntigravity,
  readAntigravityFile,
} from "../../core/adapters/antigravity/index.js";
import {
  CLAUDE_CODE_FILE_PATTERN,
  CLAUDE_CODE_INDEX_FILE_PATTERN,
  combineClaudeCode,
  readClaudeCodeFile,
} from "../../core/adapters/claude-code/index.js";
import { CODEX_FILE_PATTERN, combineCodex, readCodexFile } from "../../core/adapters/codex/index.js";
import { OPENCODE_FILE_PATTERN, combineOpenCode, readOpenCodeFile } from "../../core/adapters/opencode/index.js";
import { type Analysis, analyze, type HarnessSource, type HistoryLoadingStatus } from "../../core/api/index.js";
import { HARNESS_KEYS } from "../../core/config/schema.js";
import type { Config, ConfigError } from "../../core/config/config.js";
import type { LogFile } from "../../core/host/index.js";
import type { AdapterOutput, HarnessId } from "../../core/model/index.js";
import { loadConfigFromFiles, resolveLogRoots, resolveSessionIndexRoots } from "./config.js";
import { FsLogSource, logRootKeys } from "./log-source.js";

const HARNESS_IDS = HARNESS_KEYS as readonly HarnessId[];

export type StoreState = { readonly ok: true; readonly analysis: Analysis } | { readonly ok: false; readonly errors: readonly ConfigError[] };

/** The two steps of ADR 0014; the file result type stays private to each adapter. */
interface Adapter {
  readonly harness: HarnessId;
  readonly pattern: RegExp;
  /** Session index files under `sessionIndexRoots` (ADR 0016); null when the harness has none. */
  readonly indexPattern: RegExp | null;
  readonly readFile: (file: LogFile) => unknown;
  readonly combine: (results: readonly never[]) => AdapterOutput;
}

/**
 * Harnesses without an adapter yet (Phase 2, R-21): the files that show one is in use. Only listed, never read, so the
 * dashboard can say "found, not read yet" instead of staying silent about them (R-23).
 */
const DETECT: Readonly<Partial<Record<HarnessId, RegExp>>> = {};

/** Adapters registered with the incremental store (R-21, ADR 0014). */
const ADAPTERS: readonly Adapter[] = [
  { harness: "antigravity", pattern: ANTIGRAVITY_FILE_PATTERN, indexPattern: ANTIGRAVITY_INDEX_FILE_PATTERN, readFile: readAntigravityFile, combine: combineAntigravity },
  {
    harness: "claudeCode",
    pattern: CLAUDE_CODE_FILE_PATTERN,
    indexPattern: CLAUDE_CODE_INDEX_FILE_PATTERN,
    readFile: readClaudeCodeFile,
    combine: combineClaudeCode,
  },
  { harness: "codex", pattern: CODEX_FILE_PATTERN, indexPattern: null, readFile: readCodexFile, combine: combineCodex },
  { harness: "opencode", pattern: OPENCODE_FILE_PATTERN, indexPattern: null, readFile: readOpenCodeFile, combine: combineOpenCode },
];

interface CachedFile {
  readonly fingerprint: string;
  readonly result: unknown;
}

export interface StoreOptions {
  readonly defaultsPath: string;
  readonly userConfigPath: string;
  readonly homeDir: string;
  /** The time zone the host reports, used when usage.timeZone is "system". */
  readonly systemTimeZone: string;
  readonly platform?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

interface SeenEntry {
  readonly key: string;
  readonly adapter: Adapter;
  readonly logRoot: string;
  readonly file: string;
  readonly fingerprint: string;
  readonly mtimeMs: number;
}

const DEFERRED_YIELD_BATCH = 8;

export class AnalysisStore {
  private state: StoreState | null = null;
  private fingerprint = "";
  private checkedAt = Number.NEGATIVE_INFINITY;
  private pending: Promise<StoreState> | null = null;
  private backgroundPending: Promise<void> | null = null;
  private historyLoading: HistoryLoadingStatus | null = null;
  /** "<logRoot>/<file>" → that file's result and the fingerprint it was read with. */
  private files = new Map<string, CachedFile>();
  private configPrint = "";

  constructor(private readonly options: StoreOptions) {}

  /**
   * The latest analysis. When the poll interval has passed, a check (and, if something changed, a rebuild) starts in
   * the background and the previous result is returned meanwhile; only the very first request waits for Phase 1
   * (active sessions, ADR 0024).
   */
  current(now: number): Promise<StoreState> {
    const interval = this.state?.ok ? this.state.analysis.config.ui.pollIntervalSeconds * 1000 : 0;
    if (this.pending === null && this.backgroundPending === null && (this.state === null || now - this.checkedAt >= interval)) {
      this.pending = this.refresh(now)
        .catch((error: unknown) => {
          // A failed background check keeps the previous result; only a first load reports the failure.
          if (this.state === null) throw error;
          return this.state;
        })
        .finally(() => (this.pending = null));
    }
    if (this.state === null) return this.pending as Promise<StoreState>;
    if (this.state.ok && this.historyLoading !== null) {
      return Promise.resolve({ ok: true, analysis: { ...this.state.analysis, historyLoading: this.historyLoading } });
    }
    return Promise.resolve(this.state);
  }

  /** Resolves once any refresh and background history load in progress have finished. */
  async idle(): Promise<void> {
    await this.pending;
    await this.backgroundPending;
  }

  private async refresh(now: number): Promise<StoreState> {
    this.checkedAt = now;
    const platform = this.options.platform ?? process.platform;
    const env = this.options.env ?? process.env;
    const loaded = await loadConfigFromFiles(this.options.defaultsPath, this.options.userConfigPath, platform);
    const configPrint = await fileStamp(this.options.defaultsPath) + "|" + (await fileStamp(this.options.userConfigPath));
    if (!loaded.ok) {
      this.fingerprint = configPrint;
      return (this.state = { ok: false, errors: loaded.errors });
    }

    const config = loaded.config;
    if (configPrint !== this.configPrint) {
      // New log roots or patterns may apply: start from scratch.
      this.files = new Map();
      this.configPrint = configPrint;
    }
    const roots = resolveLogRoots(config, this.options.homeDir, env);
    const indexRoots = resolveSessionIndexRoots(config, this.options.homeDir, env);
    // Each adapter's log roots ("<harness>:<i>") and session index roots ("<harness>Index:<i>"), with their patterns.
    const rootSets = ADAPTERS.flatMap((adapter) => [
      { adapter, pattern: adapter.pattern, keys: logRootKeys(adapter.harness, roots[adapter.harness]) },
      ...(adapter.indexPattern === null ? [] : [{ adapter, pattern: adapter.indexPattern, keys: logRootKeys(`${adapter.harness}Index`, indexRoots[adapter.harness]) }]),
    ]);
    const detectSets = HARNESS_IDS.filter((harness) => DETECT[harness] !== undefined && !ADAPTERS.some((a) => a.harness === harness)).map((harness) => ({
      harness,
      pattern: DETECT[harness] as RegExp,
      keys: logRootKeys(`${harness}Detect`, roots[harness]),
    }));
    const source = new FsLogSource(Object.assign({}, ...rootSets.map((set) => set.keys), ...detectSets.map((set) => set.keys)));
    const logPrint: string[] = [];
    const seen = new Map<string, SeenEntry>();
    for (const { adapter, pattern, keys } of rootSets) {
      for (const logRoot of Object.keys(keys)) {
        for (const file of await source.list(logRoot, pattern)) {
          const { fingerprint, mtimeMs } = await source.statEntry(logRoot, file);
          const key = `${logRoot}/${file}`;
          seen.set(key, { key, adapter, logRoot, file, fingerprint, mtimeMs });
          logPrint.push(`${key}=${fingerprint}`);
        }
      }
    }
    const detected = new Map<HarnessId, number>();
    for (const { harness, pattern, keys } of detectSets) {
      for (const logRoot of Object.keys(keys)) {
        const found = await source.list(logRoot, pattern);
        detected.set(harness, (detected.get(harness) ?? 0) + found.length);
        logPrint.push(...found.map((file) => `${logRoot}/${file}`));
      }
    }
    const sources: HarnessSource[] = HARNESS_IDS.map((harness) => {
      const adapter = ADAPTERS.find((a) => a.harness === harness);
      const files = adapter === undefined ? (detected.get(harness) ?? 0) : [...seen.values()].filter((e) => e.adapter === adapter && !e.logRoot.includes("Index:")).length;
      return { harness, read: adapter !== undefined, files };
    });
    const fingerprint = `${configPrint}\n${logPrint.join("\n")}`;
    if (this.state !== null && fingerprint === this.fingerprint) return this.state;

    // ADR 0024: on cold start, read active files and small session index files first so the dashboard opens immediately,
    // then load older history in the background. On subsequent incremental refreshes, read all changed files.
    const coldStart = this.state === null;
    const activeCutoff = now - config.liveView.openWithinSeconds * 1000;
    const immediate: SeenEntry[] = [];
    const deferred: SeenEntry[] = [];
    for (const entry of seen.values()) {
      if (!coldStart || entry.logRoot.includes("Index:") || entry.mtimeMs >= activeCutoff) {
        immediate.push(entry);
      } else {
        deferred.push(entry);
      }
    }

    // ADR 0014: read only new or changed files; drop files that disappeared.
    const files = new Map<string, CachedFile>();
    for (const entry of immediate) {
      let cached = this.files.get(entry.key);
      if (cached === undefined || cached.fingerprint !== entry.fingerprint) {
        cached = { fingerprint: entry.fingerprint, result: entry.adapter.readFile(await source.read(entry.logRoot, entry.file)) };
      }
      files.set(entry.key, cached);
    }
    this.files = files;

    if (deferred.length === 0) {
      this.historyLoading = null;
      this.fingerprint = fingerprint;
      return (this.state = { ok: true, analysis: this.buildAnalysis(immediate, files, config, sources) });
    }

    const totalFiles = seen.size;
    this.historyLoading = { loadedFiles: immediate.length, totalFiles };
    this.state = { ok: true, analysis: this.buildAnalysis(immediate, files, config, sources, this.historyLoading) };
    this.backgroundPending = this.loadDeferred(source, deferred, seen, config, sources, fingerprint, totalFiles).finally(() => {
      this.backgroundPending = null;
    });
    return this.state;
  }

  private async loadDeferred(
    source: FsLogSource,
    deferred: readonly SeenEntry[],
    seen: ReadonlyMap<string, SeenEntry>,
    config: Config,
    sources: readonly HarnessSource[],
    fingerprint: string,
    totalFiles: number,
  ): Promise<void> {
    let loadedFiles = totalFiles - deferred.length;
    for (let index = 0; index < deferred.length; index++) {
      const entry = deferred[index] as SeenEntry;
      let cached = this.files.get(entry.key);
      if (cached === undefined || cached.fingerprint !== entry.fingerprint) {
        try {
          cached = { fingerprint: entry.fingerprint, result: entry.adapter.readFile(await source.read(entry.logRoot, entry.file)) };
          this.files.set(entry.key, cached);
        } catch (error) {
          if (!isMissingError(error)) throw error;
        }
      } else {
        this.files.set(entry.key, cached);
      }
      loadedFiles++;
      this.historyLoading = { loadedFiles, totalFiles };
      if ((index + 1) % DEFERRED_YIELD_BATCH === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    this.historyLoading = null;
    this.fingerprint = fingerprint;
    this.state = { ok: true, analysis: this.buildAnalysis([...seen.values()], this.files, config, sources) };
  }

  private buildAnalysis(
    entries: readonly SeenEntry[],
    files: ReadonlyMap<string, CachedFile>,
    config: Config,
    sources: readonly HarnessSource[],
    historyLoading?: HistoryLoadingStatus,
  ): Analysis {
    const byAdapter = new Map<Adapter, unknown[]>(ADAPTERS.map((a) => [a, []]));
    for (const entry of entries) {
      const cached = files.get(entry.key);
      if (cached !== undefined) byAdapter.get(entry.adapter)?.push(cached.result);
    }
    const outputs = ADAPTERS.map((adapter) => adapter.combine((byAdapter.get(adapter) ?? []) as never[]));
    return analyze(merge(outputs), config, this.timeZone(config), sources, historyLoading);
  }

  private timeZone(config: Config): string {
    return config.usage.timeZone === "system" ? this.options.systemTimeZone : config.usage.timeZone;
  }
}

function isMissingError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

function merge(outputs: readonly AdapterOutput[]): AdapterOutput {
  return {
    sessions: outputs.flatMap((o) => o.sessions),
    calls: outputs.flatMap((o) => o.calls),
    events: outputs.flatMap((o) => o.events),
    quotaSamples: outputs.flatMap((o) => o.quotaSamples),
    diagnostics: outputs.flatMap((o) => o.diagnostics),
  };
}

async function fileStamp(path: string): Promise<string> {
  try {
    const info = await stat(path);
    return `${info.size}:${info.mtimeMs}`;
  } catch {
    return "missing";
  }
}
