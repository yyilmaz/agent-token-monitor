// Session advice of ADR 0017: keep going, compact or start fresh (R-60, R-62).
// FRESH-1, POSTCOMPACT-1, SUMMARY-1 and REMAIN-1 come from the user's own history; ADVICE-1 compares the three totals in
// exact currency (ADR 0011). Pure functions over the normalized model; no thresholds besides minimum counts.

import type { Config } from "../config/config.js";
import type { Call, EpochMillis, Event, HarnessId, Session } from "../model/index.js";
import { compareStrings } from "../order.js";
import { breakEvenMessages, compareMoney, LIST_PRICE_LABEL, type Money, moneyDifference, moneyTimes, type PriceTable, priceStep, sumMoney } from "../pricing/price.js";
import type { CacheAnalysis, CallCacheResult, ModelSource } from "./cache.js";
import type { CacheStatus, OpenSession } from "./live.js";

export type AdviceConfig = Pick<Config, "rules" | "pricing">;

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

/** REMAIN-1: turn calls a session usually sends after its context first enters a context band. */
export interface RemainingMessages extends Group {
  readonly rule: "REMAIN-1";
  /** The band, from `rules.sessionAdvice.contextBandEdgesTokens`; `toTokens` null for the last, open band. */
  readonly fromTokens: number;
  readonly toTokens: number | null;
  readonly sessions: number;
  readonly minSessions: number;
  readonly medianMessages: number | null;
}

export type AdviceOption = "keepGoing" | "compact" | "startFresh";

export type ContextState = "compactActive" | "activeWorkingSet" | "explorationHeavy" | "waitingOnSubagents" | "coldLargeContext";

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

/** WORKFLOW-1: deterministic context & subagent split profile for an open session (ADR 0017). */
export interface WorkflowProfile {
  readonly rule: "WORKFLOW-1";
  readonly turns: number;
  readonly editTurns: number;
  readonly exploreTurns: number;
  readonly firstContextTokens: number | null;
  readonly baseContextTokens: number | null;
  readonly recentGrowthTokens: number | null;
  readonly subagentCount: number;
  readonly activeSubagentCount: number;
  readonly subagentTokens: number;
  /** Minimum steps for an independent subtask in a subagent to read fewer context tokens than staying in the main session. */
  readonly splitBreakEvenSteps: number | null;
  readonly contextState: ContextState | null;
  readonly recentAvgWeightedTokens: number | null;
  readonly activeWindowAvgWeightedTokens: number | null;
  readonly sessionWeightedTokens: number;
  readonly subagentWeightedTokens: number;
}

export interface OptionCost {
  readonly option: AdviceOption;
  /** Paid once, before or with the next message. */
  readonly oneTime: Money;
  readonly perMessage: Money;
  /** oneTime + horizon × perMessage. */
  readonly total: Money;
  /** Messages after which it beats keeping going; null means never. Always 0 for keepGoing. */
  readonly breakEvenMessages: number | null;
}

export type AdviceUnknownReason =
  | "modelUnknown"
  | "contextUnknown"
  | "unpricedModel"
  | "writePriceUnknown"
  | "freshStartUnknown"
  | "postCompactionUnknown"
  | "summaryUnknown"
  | "remainingUnknown";

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
  /** The lifetime writes are priced at: LIVE-1's reference lifetime (declared, else observed, else configured). */
  readonly writeLifetimeSeconds: number;
  /** null when a figure or price is missing; `unknownReason` then says which (R-16). */
  readonly advice: AdviceOption | null;
  readonly unknownReason: AdviceUnknownReason | null;
  /** Lowest total; the three options in the order keepGoing, compact, startFresh. Empty when unknown. */
  readonly options: readonly OptionCost[];
  /** Total of keeping going minus total of the advice; "0…" when the advice is to keep going. */
  readonly saving: Money | null;
  readonly horizonMessages: number | null;
  readonly figures: {
    readonly freshStart: FreshStart | null;
    readonly postCompaction: PostCompaction | null;
    readonly summary: SummarySize | null;
    readonly remaining: RemainingMessages | null;
  };
  readonly currency: string;
  readonly label: typeof LIST_PRICE_LABEL;
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
  readonly postCompactions: readonly PostCompaction[];
  readonly summaries: readonly SummarySize[];
  readonly remaining: readonly RemainingMessages[];
  readonly advice: readonly SessionAdvice[];
}

export function sessionAdvice(
  input: AdviceInput,
  cache: CacheAnalysis,
  open: readonly OpenSession[],
  settings: AdviceConfig,
  table: PriceTable,
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

  const freshStarts = freshStartsOf(cache, callById, topLevel, settings);
  const { postCompactions, summaries } = compactionFigures(input.events, bySession, callById, topLevel, context, settings);
  const remaining = remainingMessages(bySession, context, settings);

  const openTopLevel = open.filter((s) => topLevel.has(s.sessionId));
  const openTopLevelIds = new Set(openTopLevel.map((s) => s.sessionId));
  const sessionById = new Map(input.sessions.map((s) => [s.id, s]));
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

  const advice = [...openTopLevel, ...waitingTopLevel].map((s) =>
    adviseOne(s, input, open, bySession.get(s.sessionId) ?? [], callById, { freshStarts, postCompactions, summaries, remaining }, settings, table, asOf),
  );
  return { freshStarts, postCompactions, summaries, remaining, advice };
}

function freshStartsOf(
  cache: CacheAnalysis,
  callById: ReadonlyMap<string, Call>,
  topLevel: ReadonlySet<string>,
  settings: AdviceConfig,
): FreshStart[] {
  const groups = new Map<string, { first: CallCacheResult; sizes: number[] }>();
  for (const result of cache.calls) {
    if (result.previousCallId !== null || result.model === null || !topLevel.has(result.sessionId)) continue;
    const size = contextSize(callById.get(result.callId) as Call);
    if (size === null) continue;
    const k = key(result.harness, result.model, result.modelSource);
    const group = groups.get(k);
    if (group === undefined) groups.set(k, { first: result, sizes: [size] });
    else group.sizes.push(size);
  }
  const minSessions = settings.rules.freshSession.minSessions;
  return [...groups].sort(([a], [b]) => compareStrings(a, b)).map(([, { first, sizes }]) => ({
    rule: "FRESH-1",
    harness: first.harness,
    model: first.model as string,
    modelSource: first.modelSource as ModelSource,
    sessions: sizes.length,
    medianContextTokens: lowerMedian(sizes, minSessions),
    minSessions,
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

/** REMAIN-1: per band, the turn calls after a session's context first entered it, by the model of that call. */
function remainingMessages(
  bySession: ReadonlyMap<string, readonly CallCacheResult[]>,
  context: (result: CallCacheResult) => number | null,
  settings: AdviceConfig,
): RemainingMessages[] {
  const edges = settings.rules.sessionAdvice.contextBandEdgesTokens;
  const groups = new Map<string, { group: Group; band: number; counts: number[] }>();
  for (const [, results] of [...bySession].sort(([a], [b]) => compareStrings(a, b))) {
    const entered = new Set<number>();
    results.forEach((result, index) => {
      const size = context(result);
      if (size === null || result.model === null) return;
      const band = bandOf(size, edges);
      if (entered.has(band)) return;
      entered.add(band);
      const k = `${key(result.harness, result.model, result.modelSource)}\u0000${band}`;
      let entry = groups.get(k);
      if (entry === undefined) {
        entry = { group: { harness: result.harness, model: result.model, modelSource: result.modelSource as ModelSource }, band, counts: [] };
        groups.set(k, entry);
      }
      entry.counts.push(results.length - 1 - index);
    });
  }
  const min = settings.rules.sessionAdvice.minSessions;
  return [...groups]
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([, { group, band, counts }]) => ({
      rule: "REMAIN-1",
      ...group,
      fromTokens: band === 0 ? 0 : (edges[band - 1] as number),
      toTokens: band < edges.length ? (edges[band] as number) : null,
      sessions: counts.length,
      minSessions: min,
      medianMessages: lowerMedian(counts, min),
    }));
}

interface Figures {
  readonly freshStarts: readonly FreshStart[];
  readonly postCompactions: readonly PostCompaction[];
  readonly summaries: readonly SummarySize[];
  readonly remaining: readonly RemainingMessages[];
}

const EDIT_TOOLS = new Set([
  "edit_file",
  "write_file",
  "replace_file_content",
  "multi_replace_file_content",
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "apply_patch",
]);

const EXPLORE_TOOLS = new Set([
  "read_file",
  "view_file",
  "view_file_outline",
  "view_code_item",
  "grep",
  "grep_search",
  "find_by_name",
  "list_dir",
  "Read",
  "Grep",
  "Glob",
  "LS",
  "WebSearch",
  "WebFetch",
  "search_web",
]);

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

  let editTurns = 0;
  let exploreTurns = 0;
  const contexts: (number | null)[] = [];
  for (const r of activeTurns) {
    const call = callById.get(r.callId) as Call;
    contexts.push(contextSize(call));
    const hasEdit = call.toolNames.some((t) => EDIT_TOOLS.has(t));
    const hasExplore = call.toolNames.some((t) => EXPLORE_TOOLS.has(t));
    if (hasEdit) editTurns += 1;
    else if (hasExplore) exploreTurns += 1;
  }
  const firstTurnCall = sessionTurns[0] === undefined ? null : (callById.get(sessionTurns[0].callId) as Call);
  const sessionFirstContext = firstTurnCall === null ? null : contextSize(firstTurnCall);
  const firstContextTokens = contexts.find((c): c is number => c !== null) ?? sessionFirstContext;
  const baseContextTokens = freshStart?.medianContextTokens ?? firstContextTokens;
  const C = justCompacted ? baseContextTokens : s.contextTokens;
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

  const firstBandEdge = settings.rules.sessionAdvice.contextBandEdgesTokens[0] ?? 0;
  const leanLimit = baseContextTokens === null ? null : Math.max(2 * baseContextTokens, firstBandEdge);
  const isLean = justCompacted || (C !== null && leanLimit !== null && C < leanLimit);

  // Delegating a k-step subtask costs 2 parent turns at C (spawn + receive reply) plus k subagent turns at baseContextTokens:
  // k * C > 2 * C + k * baseContextTokens  <=>  k > 2 * C / (C - baseContextTokens).
  const splitBreakEvenSteps =
    !isLean && C !== null && baseContextTokens !== null && C > baseContextTokens && baseContextTokens > 0
      ? Math.floor((2 * C) / (C - baseContextTokens)) + 1
      : null;

  const warm = s.cacheStatus === "warm";
  let contextState: ContextState | null = null;
  if (activeSubagentCount > 0) {
    contextState = "waitingOnSubagents";
  } else if (isLean && C !== null && baseContextTokens !== null) {
    contextState = "compactActive";
  } else if (C !== null && baseContextTokens !== null) {
    if (!warm) contextState = "coldLargeContext";
    else if (exploreTurns >= 3 && exploreTurns > 2 * editTurns && exploreTurns * 2 >= activeTurns.length) contextState = "explorationHeavy";
    else contextState = "activeWorkingSet";
  }

  const weighted = sessionWeightedSummary(s.sessionId, input, settings);

  return {
    rule: "WORKFLOW-1",
    turns: activeTurns.length,
    editTurns,
    exploreTurns,
    firstContextTokens,
    baseContextTokens,
    recentGrowthTokens,
    subagentCount: subagentIds.size,
    activeSubagentCount,
    subagentTokens,
    splitBreakEvenSteps,
    contextState,
    recentAvgWeightedTokens: weighted.recentAvgWeightedTokens,
    activeWindowAvgWeightedTokens: weighted.activeWindowAvgWeightedTokens,
    sessionWeightedTokens: weighted.sessionWeightedTokens,
    subagentWeightedTokens: weighted.subagentWeightedTokens,
  };
}

/** ADVICE-1 for one open session. */
function adviseOne(
  s: OpenSession,
  input: AdviceInput,
  open: readonly OpenSession[],
  sessionTurns: readonly CallCacheResult[],
  callById: ReadonlyMap<string, Call>,
  figures: Figures,
  settings: AdviceConfig,
  table: PriceTable,
  asOf: EpochMillis,
): SessionAdvice {
  const warm = s.cacheStatus === "warm";
  const L = s.referenceLifetimeSeconds;
  const same = <T extends { harness: HarnessId; model: string; modelSource: ModelSource }>(list: readonly T[]) => list.find((g) => g.harness === s.harness && g.model === s.model && g.modelSource === s.modelSource) ?? null;
  const freshStart = same(figures.freshStarts);
  const postCompaction = same(figures.postCompactions);
  const summary = same(figures.summaries);
  const C = s.contextTokens;
  const remaining =
    C === null
      ? null
      : (figures.remaining.find((r) => r.harness === s.harness && r.model === s.model && r.modelSource === s.modelSource && r.fromTokens <= C && (r.toTokens === null || C < r.toTokens)) ?? null);
  const workflow = workflowProfile(s, input, open, sessionTurns, callById, freshStart, settings);

  const base = {
    rule: "ADVICE-1" as const,
    harness: s.harness,
    model: s.model,
    modelSource: s.modelSource,
    sessionId: s.sessionId,
    contextTokens: C,
    cacheStatus: s.cacheStatus,
    warm,
    writeLifetimeSeconds: L,
    figures: { freshStart, postCompaction, summary, remaining },
    currency: settings.pricing.currency,
    label: LIST_PRICE_LABEL as typeof LIST_PRICE_LABEL,
    workflow,
    callIds: [s.lastCallId],
  };
  const unknown = (reason: AdviceUnknownReason): SessionAdvice => ({ ...base, advice: null, unknownReason: reason, options: [], saving: null, horizonMessages: remaining?.medianMessages ?? null });

  if (s.model === null) return unknown("modelUnknown");
  if (C === null) return unknown("contextUnknown");
  if (!table.models.has(s.model)) return unknown("unpricedModel");
  const F = freshStart?.medianContextTokens ?? null;
  const P = postCompaction?.medianContextTokens ?? null;
  const S = summary?.medianTokens ?? null;
  const H = remaining?.medianMessages ?? null;
  if (F === null) return unknown("freshStartUnknown");
  if (P === null) return unknown("postCompactionUnknown");
  if (S === null) return unknown("summaryUnknown");
  if (H === null) return unknown("remainingUnknown");

  // Each part at the tier of the context it is paid in (ADR 0011): C before compacting, P after, F when fresh; all
  // at the prices in force at the "as of" time, when the choice is made.
  const at = (ctx: number, tokens: { cacheRead?: number; cacheWrite?: number; output?: number }) => priceStep(s.model as string, ctx, L, tokens, table, asOf);
  const parts = {
    keepOne: warm ? at(C, {}) : at(C, { cacheWrite: C }),
    keepPer: at(C, { cacheRead: C }),
    compactRead: warm ? at(C, { cacheRead: C, output: S }) : at(C, { cacheWrite: C, output: S }),
    compactWrite: warm ? at(P, { cacheWrite: S }) : at(P, { cacheWrite: P }),
    compactPer: at(P, { cacheRead: P }),
    freshOne: at(F, { cacheWrite: F }),
    freshPer: at(F, { cacheRead: F }),
  };
  if (Object.values(parts).some((m) => m === null)) return unknown("writePriceUnknown");
  const m = parts as Record<keyof typeof parts, Money>;

  const option = (name: AdviceOption, oneTime: Money, perMessage: Money): OptionCost => ({
    option: name,
    oneTime,
    perMessage,
    total: sumMoney([oneTime, moneyTimes(perMessage, H)]),
    breakEvenMessages: name === "keepGoing" ? 0 : breakEvenMessages(oneTime, perMessage, m.keepOne, m.keepPer),
  });
  const options = [
    option("keepGoing", m.keepOne, m.keepPer),
    option("compact", sumMoney([m.compactRead, m.compactWrite]), m.compactPer),
    option("startFresh", m.freshOne, m.freshPer),
  ];
  // Lowest total; on a tie the earlier, less disruptive option stays (keep going, compact, start fresh).
  const best = options.reduce((chosen, o) => (compareMoney(o.total, chosen.total) < 0 ? o : chosen));
  const keep = options[0] as OptionCost;
  return { ...base, advice: best.option, unknownReason: null, options, saving: moneyDifference(keep.total, best.total), horizonMessages: H };
}

function bandOf(tokens: number, edges: readonly number[]): number {
  let band = 0;
  while (band < edges.length && tokens >= (edges[band] as number)) band += 1;
  return band;
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

