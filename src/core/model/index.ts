// Normalized data model shared by every adapter and all analysis (ADR 0008, R-22).
// Plain JSON-safe data only: no classes, Date, Map or undefined (ADR 0008 rule 1, R-26).
// `null` means "not recorded in the log" and nothing else (R-16).

export type HarnessId = "claudeCode" | "antigravity" | "codex" | "opencode";

/** A token count, or null when the log does not record it (R-16). */
export type TokenCount = number | null;

/** Integer milliseconds since the Unix epoch, UTC. */
export type EpochMillis = number;

/** Where a record came from, so every number can be traced to log lines (R-17). */
export interface SourceRef {
  /** Configured log root as "<harness>:<index into logRoots.<harness>>", e.g. "claudeCode:0". */
  readonly logRoot: string;
  /** File path relative to that log root. */
  readonly file: string;
  /** 1-based line number. */
  readonly line: number;
}

export interface Session {
  /** "<harness>:<native id>" */
  readonly id: string;
  readonly harness: HarnessId;
  readonly nativeId: string;
  /** Subagents only: the session that started this subagent. */
  readonly parentSessionId: string | null;
  readonly isSubagent: boolean;
  /** The session that started this one as a side session (ADR 0016); null when none is recorded. */
  readonly spawnedBySessionId: string | null;
  /** The session's title as recorded by the harness (ADR 0016), else null. */
  readonly title: string | null;
  /** Working directory as logged; shown and exported as recorded (R-71). */
  readonly projectPath: string | null;
  readonly sources: readonly SourceRef[];
}

export type CallKind = "turn" | "compaction";

/** One billed model request. Adapters collapse all log lines of one request into one Call. */
export interface Call {
  readonly id: string;
  readonly sessionId: string;
  readonly timestamp: EpochMillis;
  readonly model: string | null;
  readonly kind: CallKind;
  readonly inputUncached: TokenCount;
  readonly cacheRead: TokenCount;
  readonly cacheWrite: TokenCount;
  readonly output: TokenCount;
  /** The part of `output` spent on reasoning; a subset of `output`, not an addition to it. */
  readonly reasoning: TokenCount;
  /** Cache-write tokens keyed by lifetime in seconds (e.g. "300", "3600"), when the log splits them. */
  readonly cacheWriteByTtlSeconds: Readonly<Record<string, number>> | null;
  readonly toolNames: readonly string[];
  /** STEP-1 (ADR 0017): the class of each shell tool call, in call order; the command text is not kept (R-18). */
  readonly shellClasses: readonly StepClass[];
  readonly sources: readonly SourceRef[];
}

/** STEP-1 (ADR 0017): what a tool call or turn call did. */
export type StepClass = "edit" | "explore" | "other";

export type EventType = "userTurn" | "compaction" | "subagentSpawn" | "error";

export interface Event {
  readonly id: string;
  readonly sessionId: string;
  readonly timestamp: EpochMillis;
  readonly type: EventType;
  /** Set only for "subagentSpawn". */
  readonly childSessionId: string | null;
  /** COMPACT-1 (ADR 0017): the figures a "compaction" logs; null for other types and when the harness logs none. */
  readonly compaction: CompactionFigures | null;
  readonly sources: readonly SourceRef[];
}

/** What a harness logs about one compaction; each field is null when the line lacks it (R-16). */
export interface CompactionFigures {
  readonly trigger: "manual" | "auto" | null;
  /** Context size before the compaction. */
  readonly preTokens: number | null;
  /** Size of the summary that replaces the history. */
  readonly postTokens: number | null;
}

export interface QuotaSample {
  readonly harness: HarnessId;
  readonly timestamp: EpochMillis;
  readonly window: string | null;
  readonly windowSeconds: number | null;
  readonly usedPercent: number | null;
  readonly resetsAt: EpochMillis | null;
  readonly sources: readonly SourceRef[];
}

export interface Diagnostic {
  readonly harness: HarnessId;
  readonly severity: "error" | "warning";
  /** Stable machine-readable code. */
  readonly code: string;
  /** Fixed English text. Never contains log content (R-18). */
  readonly message: string;
  readonly sources: readonly SourceRef[];
}

/** How an adapter obtains one token field (ADR 0008, capability table). */
export type FieldCapability =
  | { readonly kind: "recorded" }
  | { readonly kind: "derived"; readonly rule: string }
  | { readonly kind: "zeroByBilling"; readonly reason: string }
  | { readonly kind: "notRecorded" };

export type TokenField = "inputUncached" | "cacheRead" | "cacheWrite" | "output" | "reasoning";

export type CapabilityTable = Readonly<Record<TokenField, FieldCapability>>;

export interface AdapterOutput {
  readonly sessions: readonly Session[];
  readonly calls: readonly Call[];
  readonly events: readonly Event[];
  readonly quotaSamples: readonly QuotaSample[];
  readonly diagnostics: readonly Diagnostic[];
}
