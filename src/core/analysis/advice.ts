// Session advice of ADR 0017: keep going, compact or start fresh (R-60, R-62).
// FRESH-1, TASK-1, STEPS-1, POSTCOMPACT-1 and SUMMARY-1 come from the user's own history. ADVICE-1 decides one verdict per
// open top-level session: wait, unknown, lean, or a break-even comparison in weighted token units (R-51) for a new task
// and for the same task, stated in messages. WORKFLOW-1 is detail only. Pure functions over the normalized model;
// parameters come from the configuration (R-72).

import type { Config } from "../config/config.js";
import type { Call, EpochMillis, Event, HarnessId, Session } from "../model/index.js";
import { turnStepClass } from "../model/step.js";
import { compareStrings } from "../order.js";
import { TOKEN_WEIGHT_SCALE } from "../config/schema.js";
import type { CacheAnalysis, CallCacheResult, ModelSource } from "./cache.js";
import type { CacheStatus, OpenSession } from "./live.js";

export type AdviceConfig = Pick<Config, "rules">;

interface Group {
  readonly harness: HarnessId;
  readonly model: string;
  readonly modelSource: ModelSource;
}

/** FRESH-1: how many tokens a new session usually starts with, per harness and effective model. */
export interface FreshStart extends Group {
  readonly rule: "FRESH-1";
  readonly sessions: number;
  /** Lower median of the first turn call's context size; null with fewer than `minSessions` sessions (R-16). */
  readonly medianContextTokens: number | null;
  readonly minSessions: number;
}

/** TASK-1: how many turn calls a session usually takes, over the same sessions as FRESH-1. */
export interface TypicalTask extends Group {
  readonly rule: "TASK-1";
  readonly sessions: number;
  readonly minSessions: number;
  /** Lower median of turn calls per session; null with fewer than `minSessions` sessions (R-16). */
  readonly medianSteps: number | null;
}

/** POSTCOMPACT-1: context size of the first turn call after a compaction. */
export interface PostCompaction extends Group {
  readonly rule: "POSTCOMPACT-1";
  readonly compactions: number;
  readonly minCompactions: number;
  /** Lower median; null with fewer than `minCompactions` compactions (R-16). */
  readonly medianContextTokens: number | null;
}

/** SUMMARY-1: logged summary size (`postTokens`), the estimate of the summarization request's output. */
export interface SummarySize extends Group {
  readonly rule: "SUMMARY-1";
  readonly compactions: number;
  readonly minCompactions: number;
  readonly medianTokens: number | null;
}

/** STEPS-1: turn calls a user request usually takes; converts break-even steps into messages. */
export interface StepsPerRequest extends Group {
  readonly rule: "STEPS-1";
  readonly userTurns: number;
  readonly minUserTurns: number;
  /** Lower median; null with fewer than `minUserTurns` user turns (R-16). */
  readonly medianSteps: number | null;
}

export type AdviceOption = "keepGoing" | "compact" | "startFresh";

export interface TokenWeights {
  readonly cacheRead: number;
  readonly inputUncached: number;
  readonly cacheWrite: number;
  readonly output: number;
}

export const DEFAULT_TOKEN_WEIGHTS: TokenWeights = {
  cacheRead: 0.1,
  inputUncached: 1,
  cacheWrite: 1.25,
  output: 5,
};

export function tokenWeightsOf(settings: Pick<Config, "rules">): TokenWeights {
  return settings.rules.sessionAdvice.weights ?? DEFAULT_TOKEN_WEIGHTS;
}

export function recentTurnsWindowOf(settings: Pick<Config, "rules">): number {
  return settings.rules.sessionAdvice.recentTurnsWindow ?? 5;
}

/** Weighted token load of a single call; null when all four token counts are unknown (R-16). */
export function callWeightedTokens(call: Call, weights: TokenWeights): number | null {
  if (call.inputUncached === null && call.cacheRead === null && call.cacheWrite === null && call.output === null) return null;
  return Math.round(
    (call.cacheRead ?? 0) * weights.cacheRead +
      (call.inputUncached ?? 0) * weights.inputUncached +
      (call.cacheWrite ?? 0) * weights.cacheWrite +
      (call.output ?? 0) * weights.output,
  );
}

/** Weighted load summary for a session (since last compaction, recent window, all-time, and child subagents). */
export interface SessionWeightedSummary {
  readonly sessionId: string;
  readonly weights: TokenWeights;
  readonly recentTurnsWindow: number;
  readonly totalTurns: number;
  readonly activeTurns: number;
  readonly compactions: number;
  readonly lastStepWeightedTokens: number | null;
  readonly recentAvgWeightedTokens: number | null;
  readonly activeWindowAvgWeightedTokens: number | null;
  readonly allTimeAvgWeightedTokens: number | null;
  readonly sessionWeightedTokens: number;
  readonly subagentCount: number;
  readonly subagentTurns: number;
  readonly subagentWeightedTokens: number;
  readonly subagentAvgWeightedTokens: number | null;
  readonly combinedWeightedTokens: number;
}

export function sessionWeightedSummary(
  sessionId: string,
  input: AdviceInput,
  settings: Pick<Config, "rules">,
): SessionWeightedSummary {
  const weights = tokenWeightsOf(settings);
  const recentWindow = recentTurnsWindowOf(settings);

  let compactions = 0;
  let lastCompactionAt: number | null = null;
  for (const ev of input.events) {
    if (ev.sessionId === sessionId && ev.type === "compaction") {
      compactions += 1;
      if (lastCompactionAt === null || ev.timestamp > lastCompactionAt) lastCompactionAt = ev.timestamp;
    }
  }

  const allTurnCalls = input.calls.filter((c) => c.sessionId === sessionId && c.kind === "turn");
  const activeTurnCalls =
    lastCompactionAt === null ? allTurnCalls : allTurnCalls.filter((c) => c.timestamp > lastCompactionAt);

  const allWeighted = allTurnCalls.map((c) => callWeightedTokens(c, weights)).filter((w): w is number => w !== null);
  const activeWeighted = activeTurnCalls.map((c) => callWeightedTokens(c, weights)).filter((w): w is number => w !== null);
  const recentSlice = activeWeighted.slice(-recentWindow);

  const sum = (arr: readonly number[]) => arr.reduce((a, b) => a + b, 0);
  const avg = (arr: readonly number[]) => (arr.length === 0 ? null : Math.round(sum(arr) / arr.length));

  const sessionWeightedTokens = sum(allWeighted);
  const lastStepWeightedTokens = activeWeighted.at(-1) ?? (lastCompactionAt === null ? (allWeighted.at(-1) ?? null) : null);
  const recentAvgWeightedTokens = avg(recentSlice);
  const activeWindowAvgWeightedTokens = avg(activeWeighted);
  const allTimeAvgWeightedTokens = avg(allWeighted);

  const subagentIds = new Set(input.sessions.filter((child) => child.parentSessionId === sessionId).map((child) => child.id));
  let subagentTurns = 0;
  let subagentWeightedTokens = 0;
  for (const call of input.calls) {
    if (!subagentIds.has(call.sessionId) || call.kind !== "turn") continue;
    const w = callWeightedTokens(call, weights);
    if (w !== null) {
      subagentTurns += 1;
      subagentWeightedTokens += w;
    }
  }
  const subagentAvgWeightedTokens = subagentTurns > 0 ? Math.round(subagentWeightedTokens / subagentTurns) : null;

  return {
    sessionId,
    weights,
    recentTurnsWindow: recentWindow,
    totalTurns: allTurnCalls.length,
    activeTurns: activeTurnCalls.length,
    compactions,
    lastStepWeightedTokens,
    recentAvgWeightedTokens,
    activeWindowAvgWeightedTokens,
    allTimeAvgWeightedTokens,
    sessionWeightedTokens,
    subagentCount: subagentIds.size,
    subagentTurns,
    subagentWeightedTokens,
    subagentAvgWeightedTokens,
    combinedWeightedTokens: sessionWeightedTokens + subagentWeightedTokens,
  };
}


/** WORKFLOW-1: the session's working pattern, shown as detail only; it never sets the verdict (ADR 0017). */
export interface WorkflowProfile {
  readonly rule: "WORKFLOW-1";
  /** Turn calls in the active context window (after the latest compaction) and their STEP-1 classes. */
  readonly turns: number;
  readonly editTurns: number;
  readonly exploreTurns: number;
  readonly otherTurns: number;
  readonly firstContextTokens: number | null;
  /** FRESH-1 when known: the context a subagent or new session starts with. */
  readonly baseContextTokens: number | null;
  readonly recentGrowthTokens: number | null;
  readonly subagentCount: number;
  readonly activeSubagentCount: number;
  readonly subagentTokens: number;
  /** Minimum steps for an independent subtask in a subagent to read fewer context tokens than staying in the main session. */
  readonly splitBreakEvenSteps: number | null;
  /** The context grew mainly from read and search steps. */
  readonly explorationHeavy: boolean;
  readonly recentAvgWeightedTokens: number | null;
  readonly activeWindowAvgWeightedTokens: number | null;
  readonly sessionWeightedTokens: number;
  readonly subagentWeightedTokens: number;
}

export interface OptionLoad {
  readonly option: AdviceOption;
  /** Processed once, before or with the next step. */
  readonly oneTime: number;
  readonly perStep: number;
  /** oneTime + TASK-1 × perStep: the load over a typical task. */
  readonly total: number;
  /** First whole step count at which it matches or beats keeping going; null means never. Always 0 for keepGoing. */
  readonly breakEvenSteps: number | null;
}

/** One of the two ADVICE-1 cases: keep going against one alternative. */
export interface AdviceCase {
  readonly alternative: "compact" | "startFresh";
  /**
   * The alternative when it pays back within a typical task (TASK-1), else `keepGoing`; `keepGoing` too when a figure
   * is missing (`unknownReason` says which).
   */
  readonly advice: AdviceOption;
  readonly unknownReason: "postCompactionUnknown" | "summaryUnknown" | null;
  /** null when a figure is missing. */
  readonly option: OptionLoad | null;
  /** Break-even in user messages: ceil(break-even steps ÷ STEPS-1); null when it never breaks even or a figure is missing. */
  readonly breakEvenMessages: number | null;
  /** Keep-going total minus the alternative's total over a typical task; null when a figure is missing. */
  readonly saving: number | null;
  /** `saving` as a share of the keep-going total; null when a figure is missing or keeping going costs nothing. */
  readonly savingShare: number | null;
}

export type AdviceVerdict = "wait" | "unknown" | "lean" | "compare";

export type AdviceUnknownReason = "modelUnknown" | "contextUnknown" | "freshStartUnknown" | "taskUnknown" | "stepsUnknown";

export interface SessionAdvice {
  readonly rule: "ADVICE-1";
  readonly harness: HarnessId;
  readonly model: string | null;
  readonly modelSource: ModelSource | null;
  readonly sessionId: string;
  readonly contextTokens: number | null;
  readonly cacheStatus: CacheStatus;
  /** "warm" in LIVE-1 terms; "probablyCold" and "missedOnLastCall" count as cold. */
  readonly warm: boolean;
  /** The first matching ADVICE-1 step. */
  readonly verdict: AdviceVerdict;
  /** Set when `verdict` is "unknown" (R-16). */
  readonly unknownReason: AdviceUnknownReason | null;
  /** Running subagents that will report back into this session. */
  readonly activeSubagentCount: number;
  /** Set only when `verdict` is "compare". */
  readonly keep: OptionLoad | null;
  /** If the next request is a new task: keep going against a fresh session. */
  readonly newTask: AdviceCase | null;
  /** If it continues the current task: keep going against compacting. */
  readonly sameTask: AdviceCase | null;
  /** STEPS-1: turn calls per user message. */
  readonly stepsPerRequest: number | null;
  /** TASK-1: turn calls of a typical task; the limit for a recommended break-even and the horizon of the totals. */
  readonly taskSteps: number | null;
  /** TASK-1 in messages: ceil(taskSteps ÷ stepsPerRequest). */
  readonly taskMessages: number | null;
  readonly leanContextTokens: number;
  readonly figures: {
    readonly freshStart: FreshStart | null;
    readonly task: TypicalTask | null;
    readonly steps: StepsPerRequest | null;
    readonly postCompaction: PostCompaction | null;
    readonly summary: SummarySize | null;
  };
  readonly weights: TokenWeights;
  readonly workflow: WorkflowProfile;
  readonly callIds: readonly string[];
}

export interface AdviceInput {
  readonly sessions: readonly Session[];
  readonly calls: readonly Call[];
  readonly events: readonly Event[];
}

export interface AdviceResult {
  readonly freshStarts: readonly FreshStart[];
  readonly tasks: readonly TypicalTask[];
  readonly steps: readonly StepsPerRequest[];
  readonly postCompactions: readonly PostCompaction[];
  readonly summaries: readonly SummarySize[];
  readonly advice: readonly SessionAdvice[];
}

export function sessionAdvice(
  input: AdviceInput,
  cache: CacheAnalysis,
  open: readonly OpenSession[],
  settings: AdviceConfig,
  asOf: EpochMillis,
): AdviceResult {
  const topLevel = new Set(input.sessions.filter((s) => !s.isSubagent).map((s) => s.id));
  const callById = new Map(input.calls.map((c) => [c.id, c]));
  // Each top-level session's turn calls with their cache results, in canonical order (ADR 0009).
  const bySession = new Map<string, CallCacheResult[]>();
  for (const result of cache.calls) {
    if (!topLevel.has(result.sessionId)) continue;
    const list = bySession.get(result.sessionId);
    if (list === undefined) bySession.set(result.sessionId, [result]);
    else list.push(result);
  }
  const context = (result: CallCacheResult) => contextSize(callById.get(result.callId) as Call);

  const { freshStarts, tasks } = freshStartsOf(cache, callById, topLevel, settings);
  const steps = stepsPerRequest(input.events, bySession, callById, topLevel, settings);
  const { postCompactions, summaries } = compactionFigures(input.events, bySession, callById, topLevel, context, settings);

  const openTopLevel = open.filter((s) => topLevel.has(s.sessionId));
  const openTopLevelIds = new Set(openTopLevel.map((s) => s.sessionId));
  const sessionById = new Map(input.sessions.map((s) => [s.id, s]));
  // A top-level session with no recent call of its own still gets advice while a session under it is open.
  const waitingTopLevel: OpenSession[] = [];
  for (const s of open) {
    let cur = sessionById.get(s.sessionId);
    const seen = new Set<string>();
    while (cur !== undefined && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (topLevel.has(cur.id) && !openTopLevelIds.has(cur.id)) {
        const lastResult = (bySession.get(cur.id) ?? []).at(-1);
        if (lastResult !== undefined) {
          const lastCall = callById.get(lastResult.callId) as Call;
          openTopLevelIds.add(cur.id);
          waitingTopLevel.push({
            rule: "LIVE-1",
            sessionId: cur.id,
            harness: cur.harness,
            parentSessionId: cur.parentSessionId,
            isSubagent: cur.isSubagent,
            spawnedBySessionId: cur.spawnedBySessionId,
            title: cur.title,
            project: cur.projectPath,
            model: lastResult.model,
            modelSource: lastResult.modelSource,
            lastCallId: lastCall.id,
            lastCallAt: lastCall.timestamp,
            secondsSinceLastCall: (asOf - lastCall.timestamp) / 1000,
            contextTokens: contextSize(lastCall),
            cacheStatus: lastResult.cacheLoss ? "missedOnLastCall" : "probablyCold",
            referenceLifetimeSeconds: s.referenceLifetimeSeconds,
            referenceSource: s.referenceSource,
          });
        }
      }
      const parentId = cur.parentSessionId ?? cur.spawnedBySessionId;
      cur = parentId === null ? undefined : sessionById.get(parentId);
    }
  }

  const figures = { freshStarts, tasks, steps, postCompactions, summaries };
  const advice = [...openTopLevel, ...waitingTopLevel].map((s) =>
    adviseOne(s, input, open, bySession.get(s.sessionId) ?? [], callById, figures, settings),
  );
  return { freshStarts, tasks, steps, postCompactions, summaries, advice };
}

/** FRESH-1 and TASK-1 over the same top-level sessions, grouped by the effective model of each first turn call. */
function freshStartsOf(
  cache: CacheAnalysis,
  callById: ReadonlyMap<string, Call>,
  topLevel: ReadonlySet<string>,
  settings: AdviceConfig,
): { freshStarts: FreshStart[]; tasks: TypicalTask[] } {
  const turnsBySession = new Map<string, number>();
  for (const result of cache.calls) {
    if (topLevel.has(result.sessionId)) turnsBySession.set(result.sessionId, (turnsBySession.get(result.sessionId) ?? 0) + 1);
  }
  const groups = new Map<string, { first: CallCacheResult; sizes: number[]; turns: number[] }>();
  for (const result of cache.calls) {
    if (result.previousCallId !== null || result.model === null || !topLevel.has(result.sessionId)) continue;
    const size = contextSize(callById.get(result.callId) as Call);
    if (size === null) continue;
    const turns = turnsBySession.get(result.sessionId) as number;
    const k = key(result.harness, result.model, result.modelSource);
    const group = groups.get(k);
    if (group === undefined) groups.set(k, { first: result, sizes: [size], turns: [turns] });
    else {
      group.sizes.push(size);
      group.turns.push(turns);
    }
  }
  const minSessions = settings.rules.freshSession.minSessions;
  const sorted = [...groups].sort(([a], [b]) => compareStrings(a, b)).map(([, g]) => g);
  const group = (first: CallCacheResult): Group => ({
    harness: first.harness,
    model: first.model as string,
    modelSource: first.modelSource as ModelSource,
  });
  return {
    freshStarts: sorted.map(({ first, sizes }) => ({
      rule: "FRESH-1",
      ...group(first),
      sessions: sizes.length,
      medianContextTokens: lowerMedian(sizes, minSessions),
      minSessions,
    })),
    tasks: sorted.map(({ first, turns }) => ({
      rule: "TASK-1",
      ...group(first),
      sessions: turns.length,
      minSessions,
      medianSteps: lowerMedian(turns, minSessions),
    })),
  };
}

/**
 * STEPS-1: per user turn, the turn calls from it up to the next user turn of the same session, grouped by the model of
 * the first of them. A user turn followed by no turn call is not counted.
 */
function stepsPerRequest(
  events: readonly Event[],
  bySession: ReadonlyMap<string, readonly CallCacheResult[]>,
  callById: ReadonlyMap<string, Call>,
  topLevel: ReadonlySet<string>,
  settings: AdviceConfig,
): StepsPerRequest[] {
  const turnsBySession = new Map<string, number[]>();
  for (const event of events) {
    if (event.type !== "userTurn" || !topLevel.has(event.sessionId)) continue;
    const list = turnsBySession.get(event.sessionId);
    if (list === undefined) turnsBySession.set(event.sessionId, [event.timestamp]);
    else list.push(event.timestamp);
  }
  const groups = new Map<string, { group: Group; counts: number[] }>();
  for (const [sessionId, starts] of [...turnsBySession].sort(([a], [b]) => compareStrings(a, b))) {
    const results = bySession.get(sessionId) ?? [];
    const sorted = [...new Set(starts)].sort((a, b) => a - b);
    sorted.forEach((start, index) => {
      const end = sorted[index + 1] ?? Number.POSITIVE_INFINITY;
      const within = results.filter((r) => {
        const t = (callById.get(r.callId) as Call).timestamp;
        return t >= start && t < end;
      });
      const first = within[0];
      if (first === undefined || first.model === null) return;
      const k = key(first.harness, first.model, first.modelSource);
      let entry = groups.get(k);
      if (entry === undefined) {
        entry = { group: { harness: first.harness, model: first.model, modelSource: first.modelSource as ModelSource }, counts: [] };
        groups.set(k, entry);
      }
      entry.counts.push(within.length);
    });
  }
  const min = settings.rules.sessionAdvice.minUserTurns;
  return [...groups].sort(([a], [b]) => compareStrings(a, b)).map(([, { group, counts }]) => ({
    rule: "STEPS-1",
    ...group,
    userTurns: counts.length,
    minUserTurns: min,
    medianSteps: lowerMedian(counts, min),
  }));
}

/** POSTCOMPACT-1 and SUMMARY-1, grouped by the model of the first turn call after each compaction. */
function compactionFigures(
  events: readonly Event[],
  bySession: ReadonlyMap<string, readonly CallCacheResult[]>,
  callById: ReadonlyMap<string, Call>,
  topLevel: ReadonlySet<string>,
  context: (result: CallCacheResult) => number | null,
  settings: AdviceConfig,
): { postCompactions: PostCompaction[]; summaries: SummarySize[] } {
  const groups = new Map<string, { group: Group; after: number[]; summary: number[] }>();
  for (const event of events) {
    if (event.type !== "compaction" || !topLevel.has(event.sessionId)) continue;
    const next = (bySession.get(event.sessionId) ?? []).find((r) => (callById.get(r.callId) as Call).timestamp > event.timestamp);
    if (next === undefined || next.model === null) continue;
    const k = key(next.harness, next.model, next.modelSource);
    let entry = groups.get(k);
    if (entry === undefined) {
      entry = { group: { harness: next.harness, model: next.model, modelSource: next.modelSource as ModelSource }, after: [], summary: [] };
      groups.set(k, entry);
    }
    const size = context(next);
    if (size !== null) entry.after.push(size);
    if (event.compaction?.postTokens != null) entry.summary.push(event.compaction.postTokens);
  }
  const min = settings.rules.sessionAdvice.minCompactions;
  const sorted = [...groups].sort(([a], [b]) => compareStrings(a, b)).map(([, g]) => g);
  return {
    postCompactions: sorted.map(({ group, after }) => ({ rule: "POSTCOMPACT-1", ...group, compactions: after.length, minCompactions: min, medianContextTokens: lowerMedian(after, min) })),
    summaries: sorted.map(({ group, summary }) => ({ rule: "SUMMARY-1", ...group, compactions: summary.length, minCompactions: min, medianTokens: lowerMedian(summary, min) })),
  };
}

interface Figures {
  readonly freshStarts: readonly FreshStart[];
  readonly tasks: readonly TypicalTask[];
  readonly steps: readonly StepsPerRequest[];
  readonly postCompactions: readonly PostCompaction[];
  readonly summaries: readonly SummarySize[];
}

function workflowProfile(
  s: OpenSession,
  input: AdviceInput,
  open: readonly OpenSession[],
  sessionTurns: readonly CallCacheResult[],
  callById: ReadonlyMap<string, Call>,
  freshStart: FreshStart | null,
  settings: AdviceConfig,
): WorkflowProfile {
  let lastCompactionAt: number | null = null;
  for (const ev of input.events) {
    if (ev.sessionId === s.sessionId && ev.type === "compaction") {
      if (lastCompactionAt === null || ev.timestamp > lastCompactionAt) lastCompactionAt = ev.timestamp;
    }
  }
  const activeTurns =
    lastCompactionAt === null
      ? sessionTurns
      : sessionTurns.filter((r) => (callById.get(r.callId) as Call).timestamp > lastCompactionAt);
  const justCompacted = lastCompactionAt !== null && activeTurns.length === 0;

  const counts = { edit: 0, explore: 0, other: 0 };
  const contexts: (number | null)[] = [];
  for (const r of activeTurns) {
    const call = callById.get(r.callId) as Call;
    contexts.push(contextSize(call));
    counts[turnStepClass(call)] += 1;
  }
  const firstTurnCall = sessionTurns[0] === undefined ? null : (callById.get(sessionTurns[0].callId) as Call);
  const sessionFirstContext = firstTurnCall === null ? null : contextSize(firstTurnCall);
  const firstContextTokens = contexts.find((c): c is number => c !== null) ?? sessionFirstContext;
  const baseContextTokens = freshStart?.medianContextTokens ?? null;
  const C = s.contextTokens;
  let recentGrowthTokens: number | null = justCompacted ? 0 : null;
  if (!justCompacted && C !== null && contexts.length >= 2) {
    const anchor = contexts[Math.max(0, contexts.length - 4)] ?? firstContextTokens;
    if (anchor !== null) recentGrowthTokens = C - anchor;
  }

  const subagentIds = new Set(input.sessions.filter((child) => child.parentSessionId === s.sessionId).map((child) => child.id));
  const activeSubagentCount = open.filter(
    (child) => child.parentSessionId === s.sessionId && child.cacheStatus === "warm" && child.lastCallAt >= s.lastCallAt,
  ).length;
  let subagentTokens = 0;
  for (const call of input.calls) {
    if (!subagentIds.has(call.sessionId)) continue;
    subagentTokens += (call.inputUncached ?? 0) + (call.cacheRead ?? 0) + (call.cacheWrite ?? 0) + (call.output ?? 0);
  }

  const lean = settings.rules.sessionAdvice.leanContextTokens;
  const large = !justCompacted && C !== null && C >= lean;
  // Delegating a k-step subtask costs 2 parent turns at C (spawn + receive reply) plus k subagent turns at F:
  // k * C > 2 * C + k * F  <=>  k > 2 * C / (C - F).
  const splitBreakEvenSteps =
    large && baseContextTokens !== null && C > baseContextTokens
      ? Math.floor((2 * C) / (C - baseContextTokens)) + 1
      : null;
  const turns = activeTurns.length;
  const explorationHeavy =
    large && counts.explore >= 3 && counts.explore > 2 * counts.edit && counts.explore * 2 >= turns;

  const weighted = sessionWeightedSummary(s.sessionId, input, settings);

  return {
    rule: "WORKFLOW-1",
    turns,
    editTurns: counts.edit,
    exploreTurns: counts.explore,
    otherTurns: counts.other,
    firstContextTokens,
    baseContextTokens,
    recentGrowthTokens,
    subagentCount: subagentIds.size,
    activeSubagentCount,
    subagentTokens,
    splitBreakEvenSteps,
    explorationHeavy,
    recentAvgWeightedTokens: weighted.recentAvgWeightedTokens,
    activeWindowAvgWeightedTokens: weighted.activeWindowAvgWeightedTokens,
    sessionWeightedTokens: weighted.sessionWeightedTokens,
    subagentWeightedTokens: weighted.subagentWeightedTokens,
  };
}

/** ADVICE-1 for one open top-level session: the first matching step decides (ADR 0017). */
function adviseOne(
  s: OpenSession,
  input: AdviceInput,
  open: readonly OpenSession[],
  sessionTurns: readonly CallCacheResult[],
  callById: ReadonlyMap<string, Call>,
  figures: Figures,
  settings: AdviceConfig,
): SessionAdvice {
  const warm = s.cacheStatus === "warm";
  const same = <T extends Group>(list: readonly T[]) =>
    list.find((g) => g.harness === s.harness && g.model === s.model && g.modelSource === s.modelSource) ?? null;
  const freshStart = same(figures.freshStarts);
  const task = same(figures.tasks);
  const steps = same(figures.steps);
  const postCompaction = same(figures.postCompactions);
  const summary = same(figures.summaries);
  const workflow = workflowProfile(s, input, open, sessionTurns, callById, freshStart, settings);
  const { leanContextTokens } = settings.rules.sessionAdvice;
  const C = s.contextTokens;
  const F = freshStart?.medianContextTokens ?? null;
  const T = task?.medianSteps ?? null;
  const R = steps?.medianSteps ?? null;
  // Steps → user messages, rounded up: a break-even inside a message needs that whole message.
  const messages = (count: number | null) => (count === null || R === null || R === 0 ? null : Math.ceil(count / R));

  const weights = tokenWeightsOf(settings);
  const base = {
    rule: "ADVICE-1" as const,
    harness: s.harness,
    model: s.model,
    modelSource: s.modelSource,
    sessionId: s.sessionId,
    contextTokens: C,
    cacheStatus: s.cacheStatus,
    warm,
    activeSubagentCount: workflow.activeSubagentCount,
    stepsPerRequest: R,
    taskSteps: T,
    taskMessages: messages(T),
    leanContextTokens,
    figures: { freshStart, task, steps, postCompaction, summary },
    weights,
    workflow,
    callIds: [s.lastCallId],
  };
  const settle = (verdict: Exclude<AdviceVerdict, "compare">, unknownReason: AdviceUnknownReason | null = null): SessionAdvice => ({
    ...base, verdict, unknownReason, keep: null, newTask: null, sameTask: null,
  });

  if (workflow.activeSubagentCount > 0) return settle("wait");
  if (s.model === null) return settle("unknown", "modelUnknown");
  if (C === null) return settle("unknown", "contextUnknown");
  if (C < leanContextTokens) return settle("lean");
  if (F === null) return settle("unknown", "freshStartUnknown");
  if (T === null) return settle("unknown", "taskUnknown");
  if (R === null) return settle("unknown", "stepsUnknown");

  // Exact millionths so fractional weights cannot change ties or break-even steps (ADR 0017).
  const units = (weight: number) => BigInt(Math.round(weight * TOKEN_WEIGHT_SCALE));
  const read = units(weights.cacheRead);
  const write = units(weights.cacheWrite);
  const output = units(weights.output);
  const horizon = BigInt(T);
  const context = BigInt(C);
  const fresh = BigInt(F);
  const keepInitial = warm ? 0n : context * write;
  const keepPerStep = context * read;
  const keepTotal = keepInitial + horizon * keepPerStep;
  const load = (value: bigint) => Number(value) / TOKEN_WEIGHT_SCALE;

  const optionLoad = (option: AdviceOption, initial: bigint, perStep: bigint): { load: OptionLoad; total: bigint } => {
    const total = initial + horizon * perStep;
    const initialGap = initial - keepInitial;
    const perStepSaving = keepPerStep - perStep;
    const breakEvenSteps =
      initialGap <= 0n ? 0 : perStepSaving <= 0n ? null : Number((initialGap + perStepSaving - 1n) / perStepSaving);
    return { load: { option, oneTime: load(initial), perStep: load(perStep), total: load(total), breakEvenSteps }, total };
  };
  const decide = (alternative: AdviceCase["alternative"], option: { load: OptionLoad; total: bigint }): AdviceCase => {
    // Recommend the alternative only when it pays back within a typical task: strictly cheaper over TASK-1 steps.
    // A tie keeps going, the less disruptive option.
    const saving = keepTotal - option.total;
    const qualifies = saving > 0n;
    return {
      alternative,
      advice: qualifies ? alternative : "keepGoing",
      unknownReason: null,
      option: option.load,
      breakEvenMessages: messages(option.load.breakEvenSteps),
      saving: load(saving),
      savingShare: keepTotal === 0n ? null : Number(saving) / Number(keepTotal),
    };
  };

  const keep = optionLoad("keepGoing", keepInitial, keepPerStep);
  const newTask = decide("startFresh", optionLoad("startFresh", fresh * write, fresh * read));

  const P = postCompaction?.medianContextTokens ?? null;
  const S = summary?.medianTokens ?? null;
  let sameTask: AdviceCase;
  if (P === null || S === null) {
    sameTask = {
      alternative: "compact",
      advice: "keepGoing",
      unknownReason: P === null ? "postCompactionUnknown" : "summaryUnknown",
      option: null,
      breakEvenMessages: null,
      saving: null,
      savingShare: null,
    };
  } else {
    const post = BigInt(P);
    const summarySize = BigInt(S);
    const compactInitial = (warm ? context * read + summarySize * write : (context + post) * write) + summarySize * output;
    sameTask = decide("compact", optionLoad("compact", compactInitial, post * read));
  }

  return { ...base, verdict: "compare", unknownReason: null, keep: keep.load, newTask, sameTask };
}

/** Lower middle value; null below `min` values. */
function lowerMedian(values: number[], min: number): number | null {
  if (values.length < min || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] as number;
}

function key(harness: HarnessId, model: string, source: ModelSource | null): string {
  return `${harness}\u0000${model}\u0000${source}`;
}

function contextSize(call: Call): number | null {
  if (call.inputUncached === null || call.cacheRead === null || call.cacheWrite === null) return null;
  return call.inputUncached + call.cacheRead + call.cacheWrite;
}
