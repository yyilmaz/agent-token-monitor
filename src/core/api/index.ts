// Data API payloads (ADR 0013). Pure functions shared by every host: the standalone server answers HTTP requests
// with them, a VS Code host will answer Webview messages with the same payloads.
// The heavy analysis runs once per log change (`analyze`); the parts that depend on the "as of" time run per request.

import { antigravityCapabilities } from "../adapters/antigravity/index.js";
import { claudeCodeCapabilities } from "../adapters/claude-code/index.js";
import { codexCapabilities } from "../adapters/codex/index.js";
import { callWeightedTokens, sessionAdvice, sessionWeightedSummary, type SessionWeightedSummary, tokenWeightsOf } from "../analysis/advice.js";
import { analyzeCache, type CacheAnalysis, type MissCauseKind, type ModelSource } from "../analysis/cache.js";
import { openSessions, sessionTree } from "../analysis/live.js";
import { dayIn, type UsageCall, usageCalls, type UsagePeriodKind, usageTotals } from "../analysis/usage.js";
import type { Config, ConfigError } from "../config/config.js";
import type { AdapterOutput, CapabilityTable, Diagnostic, EpochMillis, HarnessId } from "../model/index.js";
import { compareByTimeThenSource, compareStrings } from "../order.js";

/** Capability tables of the adapters that exist (ADR 0008). */
export const CAPABILITIES: Readonly<Partial<Record<HarnessId, CapabilityTable>>> = {
  claudeCode: claudeCodeCapabilities,
  antigravity: antigravityCapabilities,
  codex: codexCapabilities,
};

/** Which harnesses this computer has and whether their logs are read (R-20, R-21, R-23). */
export interface HarnessSource {
  readonly harness: HarnessId;
  /** An adapter exists and its log files are analyzed. */
  readonly read: boolean;
  /** Log files found under the harness's log roots; for a harness without an adapter, only listed, never read. */
  readonly files: number;
}

export interface Analysis {
  readonly data: AdapterOutput;
  readonly sources: readonly HarnessSource[];
  readonly config: Config;
  readonly timeZone: string;
  readonly cache: CacheAnalysis;
  readonly diagnosticCounts: ReturnType<typeof diagnosticCounts>;
  readonly calls: readonly UsageCall[];
}

/** Everything that does not depend on the "as of" time. */
export function analyze(data: AdapterOutput, config: Config, timeZone: string, sources: readonly HarnessSource[] = []): Analysis {
  const cache = analyzeCache(data, config);
  const ordered = [...data.calls].sort((a, b) => compareByTimeThenSource(a, b) || compareStrings(a.id, b.id));
  return {
    data,
    sources,
    config,
    timeZone,
    cache,
    diagnosticCounts: diagnosticCounts(data.diagnostics),
    calls: usageCalls(ordered, data.sessions, config),
  };
}

/** Fields every response carries (R-10, R-63). */
interface Envelope {
  readonly asOf: EpochMillis;
  readonly timeZone: string;
  readonly configuration: Config;
  readonly diagnosticCount: number;
}

const envelope = (analysis: Analysis, asOf: EpochMillis): Envelope => ({
  asOf,
  timeZone: analysis.timeZone,
  configuration: analysis.config,
  diagnosticCount: analysis.diagnosticCounts.errors + analysis.diagnosticCounts.warnings,
});

/** Every response when the configuration is invalid: errors and no results (ADR 0007). */
export function configErrorResponse(errors: readonly ConfigError[]) {
  return { configErrors: errors };
}

export function overview(analysis: Analysis, asOf: EpochMillis) {
  const today = dayIn(asOf, analysis.timeZone);
  const weights = tokenWeightsOf(analysis.config);
  const day = usageTotals(
    analysis.calls.filter((c) => dayIn(c.call.timestamp, analysis.timeZone) === today),
    "day",
    analysis.timeZone,
    weights,
  )[0];
  const month = usageTotals(
    analysis.calls.filter((c) => dayIn(c.call.timestamp, analysis.timeZone).slice(0, 7) === today.slice(0, 7)),
    "month",
    analysis.timeZone,
    weights,
  )[0];
  const open = openSessions(analysis.data, analysis.cache, analysis.config, asOf);
  const tree = sessionTree(analysis.data.sessions, open);
  const advice = sessionAdvice(analysis.data, analysis.cache, open, analysis.config, asOf);
  const sessionLoads: Record<string, SessionWeightedSummary> = {};
  for (const row of tree) {
    sessionLoads[row.sessionId] = sessionWeightedSummary(row.sessionId, analysis.data, analysis.config);
  }
  return {
    ...envelope(analysis, asOf),
    openSessions: open,
    sessionTree: tree,
    sessionLoads,
    today: { period: today, usage: day ?? null },
    thisMonth: { period: today.slice(0, 7), usage: month ?? null },
    // ADR 0017: one advice per open top-level session (keep going, compact, start fresh).
    sessionAdvice: advice.advice,
    diagnostics: analysis.diagnosticCounts,
  };
}

export function usage(analysis: Analysis, asOf: EpochMillis, by: UsagePeriodKind) {
  return { ...envelope(analysis, asOf), by, sources: analysis.sources, periods: usageTotals(analysis.calls, by, analysis.timeZone, tokenWeightsOf(analysis.config)) };
}

export interface CauseTotal {
  readonly harness: HarnessId;
  readonly model: string | null;
  readonly modelSource: ModelSource | null;
  readonly cause: MissCauseKind;
  readonly losses: number;
  /** Re-read tokens of these losses; calls where it is unknown are counted apart (R-16). */
  readonly reReadTokens: number;
  readonly reReadUnknown: number;
}

export function cache(analysis: Analysis, asOf: EpochMillis) {
  const totals = new Map<string, { harness: HarnessId; model: string | null; modelSource: ModelSource | null; cause: MissCauseKind; losses: number; reReadTokens: number; reReadUnknown: number }>();
  for (const call of analysis.cache.calls) {
    if (call.cause === null) continue;
    const key = JSON.stringify([call.harness, call.model, call.modelSource, call.cause.cause]);
    let total = totals.get(key);
    if (total === undefined) {
      total = { harness: call.harness, model: call.model, modelSource: call.modelSource, cause: call.cause.cause, losses: 0, reReadTokens: 0, reReadUnknown: 0 };
      totals.set(key, total);
    }
    total.losses += 1;
    if (call.reReadTokens === null) total.reReadUnknown += 1;
    else total.reReadTokens += call.reReadTokens;
  }
  const causes: CauseTotal[] = [...totals].sort(([a], [b]) => compareStrings(a, b)).map(([, t]) => t);
  return { ...envelope(analysis, asOf), lifetimes: analysis.cache.lifetimes, declared: analysis.cache.declared, causes };
}

export function session(analysis: Analysis, asOf: EpochMillis, sessionId: string) {
  const found = analysis.data.sessions.find((s) => s.id === sessionId);
  if (found === undefined) return null;
  const cacheById = new Map(analysis.cache.calls.map((r) => [r.callId, r]));
  // ADR 0016: subagents are listed newest first by their last call; one without calls goes last, ties by id.
  const lastCallAt: Record<string, EpochMillis | null> = {};
  for (const c of analysis.data.calls) {
    const seen = lastCallAt[c.sessionId];
    if (seen === undefined || seen === null || c.timestamp > seen) lastCallAt[c.sessionId] = c.timestamp;
  }
  const subagentLastCallAt: Record<string, EpochMillis | null> = {};
  const children = analysis.data.sessions
    .filter((s) => s.parentSessionId === sessionId)
    .map((s) => {
      subagentLastCallAt[s.id] = lastCallAt[s.id] ?? null;
      return s.id;
    })
    .sort((a, b) => (subagentLastCallAt[b] ?? Number.NEGATIVE_INFINITY) - (subagentLastCallAt[a] ?? Number.NEGATIVE_INFINITY) || compareStrings(a, b));
  const weights = tokenWeightsOf(analysis.config);
  const subagentSummaries: Record<string, SessionWeightedSummary> = {};
  for (const childId of children) {
    subagentSummaries[childId] = sessionWeightedSummary(childId, analysis.data, analysis.config);
  }
  return {
    ...envelope(analysis, asOf),
    session: found,
    weighted: sessionWeightedSummary(sessionId, analysis.data, analysis.config),
    children,
    subagentLastCallAt,
    subagentSummaries,
    sideSessions: analysis.data.sessions
      .filter((s) => s.spawnedBySessionId === sessionId)
      .map((s) => ({ id: s.id, title: s.title }))
      .sort((a, b) => compareStrings(a.id, b.id)),
    titles: titlesOf(analysis.data.sessions, [found.parentSessionId, found.spawnedBySessionId, ...children]),
    calls: analysis.calls
      .filter((c) => c.call.sessionId === sessionId)
      .map((c) => ({
        call: c.call,
        model: c.model,
        modelSource: c.modelSource,
        cache: cacheById.get(c.call.id) ?? null,
        weightedTokens: callWeightedTokens(c.call, weights),
      })),
    events: analysis.data.events.filter((e) => e.sessionId === sessionId).sort((a, b) => compareByTimeThenSource(a, b) || compareStrings(a.id, b.id)),
  };
}

export function diagnostics(analysis: Analysis, asOf: EpochMillis) {
  return { ...envelope(analysis, asOf), diagnostics: analysis.data.diagnostics };
}

/** Titles of the linked sessions a session view names, so links read as names. */
function titlesOf(sessions: readonly { id: string; title: string | null }[], ids: readonly (string | null)[]): Record<string, string | null> {
  const titles: Record<string, string | null> = {};
  for (const id of ids) if (id !== null) titles[id] = sessions.find((s) => s.id === id)?.title ?? null;
  return titles;
}

function diagnosticCounts(list: readonly Diagnostic[]) {
  const byCode: Record<string, number> = {};
  for (const d of list) byCode[`${d.harness}:${d.code}`] = (byCode[`${d.harness}:${d.code}`] ?? 0) + 1;
  return {
    errors: list.filter((d) => d.severity === "error").length,
    warnings: list.filter((d) => d.severity === "warning").length,
    byCode,
  };
}
