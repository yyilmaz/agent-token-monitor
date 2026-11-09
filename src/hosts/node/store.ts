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
import { type Analysis, analyze, type HarnessSource } from "../../core/api/index.js";
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
const DETECT: Readonly<Partial<Record<HarnessId, RegExp>>> = {
  codex: /(^|\/)rollout-[^/]*\.jsonl$/,
  opencode: /^opencode\.db$/,
};

/** Adapters that exist; Codex and OpenCode follow in Phase 2 (R-21). */
const ADAPTERS: readonly Adapter[] = [
  { harness: "antigravity", pattern: ANTIGRAVITY_FILE_PATTERN, indexPattern: ANTIGRAVITY_INDEX_FILE_PATTERN, readFile: readAntigravityFile, combine: combineAntigravity },
  {
    harness: "claudeCode",
    pattern: CLAUDE_CODE_FILE_PATTERN,
    indexPattern: CLAUDE_CODE_INDEX_FILE_PATTERN,
    readFile: readClaudeCodeFile,
    combine: combineClaudeCode,
  },
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
}

export class AnalysisStore {
  private state: StoreState | null = null;
  private fingerprint = "";
  private checkedAt = Number.NEGATIVE_INFINITY;
  private pending: Promise<StoreState> | null = null;
  /** "<logRoot>/<file>" → that file's result and the fingerprint it was read with. */
  private files = new Map<string, CachedFile>();
  private configPrint = "";

  constructor(private readonly options: StoreOptions) {}

  /**
   * The latest analysis. When the poll interval has passed, a check (and, if something changed, a rebuild) starts in
   * the background and the previous result is returned meanwhile; only the very first request waits for it.
   */
  current(now: number): Promise<StoreState> {
    const interval = this.state?.ok ? this.state.analysis.config.ui.pollIntervalSeconds * 1000 : 0;
    if (this.pending === null && (this.state === null || now - this.checkedAt >= interval)) {
      this.pending = this.refresh(now)
        .catch((error: unknown) => {
          // A failed background check keeps the previous result; only a first load reports the failure.
          if (this.state === null) throw error;
          return this.state;
        })
        .finally(() => (this.pending = null));
    }
    return this.state === null ? (this.pending as Promise<StoreState>) : Promise.resolve(this.state);
  }

  /** Resolves once a background check or rebuild in progress has finished. */
  async idle(): Promise<void> {
    await this.pending;
  }

  private async refresh(now: number): Promise<StoreState> {
    this.checkedAt = now;
    const loaded = await loadConfigFromFiles(this.options.defaultsPath, this.options.userConfigPath);
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
    const roots = resolveLogRoots(config, this.options.homeDir);
    const indexRoots = resolveSessionIndexRoots(config, this.options.homeDir);
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
    const seen = new Map<string, { adapter: Adapter; logRoot: string; file: string; fingerprint: string }>();
    for (const { adapter, pattern, keys } of rootSets) {
      for (const logRoot of Object.keys(keys)) {
        for (const file of await source.list(logRoot, pattern)) {
          const fingerprint = await source.fingerprint(logRoot, file);
          seen.set(`${logRoot}/${file}`, { adapter, logRoot, file, fingerprint });
          logPrint.push(`${logRoot}/${file}=${fingerprint}`);
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

    // ADR 0014: read only new or changed files; drop files that disappeared.
    const files = new Map<string, CachedFile>();
    const byAdapter = new Map<Adapter, unknown[]>(ADAPTERS.map((a) => [a, []]));
    for (const [key, entry] of seen) {
      let cached = this.files.get(key);
      if (cached === undefined || cached.fingerprint !== entry.fingerprint) {
        cached = { fingerprint: entry.fingerprint, result: entry.adapter.readFile(await source.read(entry.logRoot, entry.file)) };
      }
      files.set(key, cached);
      byAdapter.get(entry.adapter)?.push(cached.result);
    }
    this.files = files;
    const outputs = ADAPTERS.map((adapter) => adapter.combine((byAdapter.get(adapter) ?? []) as never[]));
    this.fingerprint = fingerprint;
    return (this.state = { ok: true, analysis: analyze(merge(outputs), config, this.timeZone(config), sources) });
  }

  private timeZone(config: Config): string {
    return config.usage.timeZone === "system" ? this.options.systemTimeZone : config.usage.timeZone;
  }
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
